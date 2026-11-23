import { existsSync, readFileSync } from "fs";
import path from "path";

import { run } from "./subprocess";

// Assembles the deterministic parts of a pull request description. The
// agent fills in the sections marked for it (what changed and why, risks).

export type ReportInput = {
  projectRoot: string;
  baseRef: string;
  // extra sections already rendered by other commands (verify, audit)
  sections?: string[];
};

const versionChanges = async (projectRoot: string, baseRef: string) => {
  const { stdout } = await run(
    `git diff ${baseRef} -- '*package.json'`,
    { cwd: projectRoot },
  );
  const removed = new Map<string, string>();
  const changes: { file: string; name: string; from?: string; to: string }[] = [];
  let file = "package.json";
  for (const line of stdout.split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header?.[1]) {
      file = header[1];
      removed.clear();
      continue;
    }
    const m = /^([+-])\s*"([^"]+)": "([^"]+)",?$/.exec(line);
    if (!m) continue;
    const [, sign, name, version] = m;
    if (sign === "-") removed.set(name!, version!);
    else if (removed.get(name!) !== version) {
      changes.push({ file, name: name!, from: removed.get(name!), to: version! });
    }
  }
  return changes.filter((c) => !["version", "name"].includes(c.name));
};

export const buildReport = async ({
  projectRoot,
  baseRef,
  sections = [],
}: ReportInput) => {
  const changes = await versionChanges(projectRoot, baseRef);
  const { stdout: stat } = await run(
    `git diff --shortstat ${baseRef} -- . ':!*package-lock.json' ':!*pnpm-lock.yaml' ':!*yarn.lock' ':!*bun.lock*'`,
    { cwd: projectRoot },
  );
  const { stdout: log } = await run(`git log --oneline ${baseRef}..HEAD`, {
    cwd: projectRoot,
  });

  const progress = path.join(projectRoot, ".safebump", "progress.md");
  const multiFile = changes.some((c) => c.file !== "package.json");

  return [
    `## Dependency upgrade`,
    "",
    multiFile ? `| Package | Manifest | From | To |\n|---|---|---|---|` : `| Package | From | To |\n|---|---|---|`,
    ...changes.map((c) =>
      multiFile
        ? `| \`${c.name}\` | ${c.file} | ${c.from ?? "(new)"} | ${c.to} |`
        : `| \`${c.name}\` | ${c.from ?? "(new)"} | ${c.to} |`,
    ),
    "",
    `Source changes: ${stat.trim() || "none"} (lockfiles excluded).`,
    ...(log.trim()
      ? ["", "<details><summary>Commits</summary>", "", "```", log.trim(), "```", "</details>"]
      : []),
    "",
    `## What changed and why`,
    "",
    `<!-- agent: one bullet per kind of change, citing the migration guide -->`,
    "",
    `## Verify manually`,
    "",
    `<!-- agent: behavior changes the type checker can't see, as a reviewer checklist -->`,
    "",
    `## Open questions`,
    "",
    `<!-- agent: decisions left to a human, or "None" -->`,
    ...sections.flatMap((s) => ["", s]),
    ...(existsSync(progress)
      ? ["", "<details><summary>Migration log</summary>", "", readFileSync(progress, "utf-8").trim(), "</details>"]
      : []),
    "",
  ].join("\n");
};
