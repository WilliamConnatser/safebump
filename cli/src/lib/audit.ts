import { readFileSync, statSync } from "fs";
import path from "path";

import { run } from "./subprocess";

export type AuditRule =
  | "as-any"
  | "as-unknown-as"
  | "any-type"
  | "ts-directive"
  | "lint-suppression"
  | "non-null-assertion"
  | "test-weakened"
  | "test-file-deleted"
  | "assertions-removed"
  | "tsconfig-weakened";

export type AuditFinding = {
  file: string;
  // 0 for file-level findings
  line: number;
  rule: AuditRule;
  text: string;
};

export type AuditResult = {
  baseRef: string;
  findings: AuditFinding[];
  ok: boolean;
};

// installs and version bumps legitimately touch these; the rest is the
// agent's own edits
const IGNORED_FILE =
  /(^|\/)(node_modules|\.safebump)\/|(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;
const CODE_FILE = /\.([cm]?[jt]sx?|vue|svelte|astro)$/;
const TSCONFIG_FILE = /(^|\/)[jt]sconfig[^/]*\.json$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//;
const MAX_UNTRACKED_BYTES = 1_000_000;

// directives only mean something inside a comment
const COMMENT_RULES: { rule: AuditRule; pattern: RegExp }[] = [
  { rule: "ts-directive", pattern: /\/[/*].*@ts-(ignore|expect-error|nocheck)\b/ },
  {
    rule: "lint-suppression",
    pattern: /\/[/*].*\b(eslint-disable|biome-ignore|oxlint-disable)\b/,
  },
];

// matched against the line with strings and comments blanked out
const CODE_RULES: { rule: AuditRule; pattern: RegExp }[] = [
  { rule: "as-unknown-as", pattern: /\bas\s+unknown\s+as\b/ },
  { rule: "as-any", pattern: /\bas\s+any\b/ },
  // ": any", "<any>", "Record<string, any>", "any[]"
  { rule: "any-type", pattern: /:\s*any\b|[<,]\s*any\s*[>,\[]|\bany\[\]/ },
  // foo!.bar  foo!)  foo![0]  foo!,  foo!;  but not != / !== / !negation
  { rule: "non-null-assertion", pattern: /[\w$)\]]!(?=[.\[),;])/ },
  {
    rule: "test-weakened",
    pattern:
      /\b(?:it|test|describe|suite|context|bench)(?:\.\w+)*\.(?:skip|only|todo|skipIf|runIf)\b|\b(?:xit|xtest|xdescribe|xcontext|fit|fdescribe)\s*\(/,
  },
];

const TSCONFIG_RULE =
  /"(strict|noImplicitAny|strictNullChecks|strictFunctionTypes|strictPropertyInitialization|noUncheckedIndexedAccess)"\s*:\s*false|"(checkJs)"\s*:\s*false/;

const ASSERTION = /\bexpect\s*\(|\bassert(?:\.\w+)*\s*\(|\.should\b/g;

// Blanks string literals (and, for code rules, comments) so `"as any"` in a
// string or a URL doesn't match. Template literals spanning lines are rare enough
// in diffs to ignore.
const stripStrings = (line: string) =>
  line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');

const codePart = (line: string) => {
  const trimmed = line.trim();
  if (/^(\/\/|\/\*|\*)/.test(trimmed)) return "";
  return stripStrings(line)
    .replace(/\/\*.*?\*\//g, " ")
    .replace(/\/\/.*$/, "");
};

const checkLine = (file: string, line: number, text: string) => {
  const findings: AuditFinding[] = [];
  const add = (rule: AuditRule) =>
    findings.push({ file, line, rule, text: text.trim().slice(0, 200) });

  if (TSCONFIG_FILE.test(file)) {
    if (TSCONFIG_RULE.test(text)) add("tsconfig-weakened");
    return findings;
  }
  if (!CODE_FILE.test(file)) return findings;

  const noStrings = stripStrings(text);
  for (const { rule, pattern } of COMMENT_RULES) {
    if (pattern.test(noStrings)) add(rule);
  }
  const code = codePart(text);
  for (const { rule, pattern } of CODE_RULES) {
    if (pattern.test(code)) add(rule);
  }
  return findings;
};

const countAssertions = (lines: string[]) =>
  lines.reduce(
    (n, l) => n + (codePart(l).match(ASSERTION)?.length ?? 0),
    0,
  );

type FileDiff = {
  file: string;
  deleted: boolean;
  added: { line: number; text: string }[];
  removed: string[];
};

const parseDiff = (diff: string): FileDiff[] => {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let oldPath = "";
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = undefined;
      oldPath = "";
    } else if (line.startsWith("--- ")) {
      oldPath = line.slice(4).replace(/^a\//, "");
    } else if (line.startsWith("+++ ")) {
      const target = line.slice(4);
      current =
        target === "/dev/null"
          ? { file: oldPath, deleted: true, added: [], removed: [] }
          : { file: target.replace(/^b\//, ""), deleted: false, added: [], removed: [] };
      files.push(current);
    } else if (line.startsWith("@@")) {
      newLine = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (current && line.startsWith("+")) {
      current.added.push({ line: newLine++, text: line.slice(1) });
    } else if (current && line.startsWith("-")) {
      current.removed.push(line.slice(1));
    } else if (current && line.startsWith(" ")) {
      newLine++;
    }
  }
  return files;
};

// untracked files don't show in `git diff`; treat them as entirely added
const untrackedFiles = async (projectRoot: string): Promise<FileDiff[]> => {
  const { stdout } = await run("git ls-files --others --exclude-standard", {
    cwd: projectRoot,
  });
  const files: FileDiff[] = [];
  for (const file of stdout.split("\n").filter(Boolean)) {
    if (IGNORED_FILE.test(file)) continue;
    if (!CODE_FILE.test(file) && !TSCONFIG_FILE.test(file)) continue;
    const abs = path.join(projectRoot, file);
    if (statSync(abs).size > MAX_UNTRACKED_BYTES) continue;
    const content = readFileSync(abs, "utf-8");
    if (content.includes("\0")) continue;
    files.push({
      file,
      deleted: false,
      added: content.split("\n").map((text, i) => ({ line: i + 1, text })),
      removed: [],
    });
  }
  return files;
};

export const auditDiff = async (
  projectRoot: string,
  baseRef = "HEAD",
): Promise<AuditResult> => {
  // --relative keeps paths (and the scope) relative to the project in a monorepo
  const diff = await run(
    `git diff --no-color --no-ext-diff --relative -U0 ${baseRef} -- .`,
    { cwd: projectRoot },
  );
  if (diff.code !== 0) {
    throw new Error(`git diff ${baseRef} failed:\n${diff.stderr.trim()}`);
  }

  const files = [
    ...parseDiff(diff.stdout),
    ...(await untrackedFiles(projectRoot)),
  ].filter((f) => !IGNORED_FILE.test(f.file));

  const findings: AuditFinding[] = [];
  for (const f of files) {
    const isTest = TEST_FILE.test(f.file);
    if (f.deleted) {
      if (isTest) {
        findings.push({ file: f.file, line: 0, rule: "test-file-deleted", text: "test file deleted" });
      }
      continue;
    }
    for (const { line, text } of f.added) {
      findings.push(...checkLine(f.file, line, text));
    }
    if (isTest) {
      const removed = countAssertions(f.removed);
      const added = countAssertions(f.added.map((a) => a.text));
      if (removed > added) {
        findings.push({
          file: f.file,
          line: 0,
          rule: "assertions-removed",
          text: `${removed - added} fewer assertion(s) (${removed} removed, ${added} added)`,
        });
      }
    }
  }
  return { baseRef, findings, ok: findings.length === 0 };
};

const RULE_HINTS: Record<AuditRule, string> = {
  "as-any": "cast to any hides the type error instead of fixing it",
  "as-unknown-as": "double cast bypasses type checking",
  "any-type": "explicit any",
  "ts-directive": "suppresses type errors",
  "lint-suppression": "suppresses lint errors",
  "non-null-assertion": "asserts a possibly-undefined value away",
  "test-weakened": "skips or narrows tests",
  "test-file-deleted": "removes tests",
  "assertions-removed": "test file lost assertions",
  "tsconfig-weakened": "turns off compiler strictness",
};

export const printAudit = (r: AuditResult) => {
  if (r.ok) {
    console.log(`No suppressions, casts or test weakening added since ${r.baseRef}.`);
    return;
  }
  console.log(
    `${r.findings.length} suspicious change(s) since ${r.baseRef}. Fix the underlying error, or justify each one to the user.`,
  );
  const byRule = new Map<AuditRule, AuditFinding[]>();
  for (const f of r.findings) {
    byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  }
  for (const [rule, items] of byRule) {
    console.log(`\n## ${rule} (${items.length}): ${RULE_HINTS[rule]}`);
    for (const f of items) {
      console.log(
        f.line > 0 ? `- ${f.file}:${f.line}  ${f.text}` : `- ${f.file}  ${f.text}`,
      );
    }
  }
};
