import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

import type { Checker } from "./checker";
import { getBuildErrors } from "./checker";
import {
  findPackageManager,
  readPackageJson,
  runScriptCommand,
} from "./packages";
import { stateDir } from "./state";
import { run } from "./subprocess";

const SCRIPTS = ["test", "lint", "build"] as const;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_LINES = 60;

// scripts that never exit on their own would just burn the timeout
const LONG_RUNNING =
  /--watch\b|(^|\s)-w(\s|$)|\bwatch\b|\bserve\b|\bdev\b|\bstart\b/;
// what `npm init` writes; it fails without testing anything
const PLACEHOLDER_TEST = /no test specified/;

export type VerifyOptions = { timeoutMs?: number };

type CheckRun = {
  name: string;
  command: string;
  status: "pass" | "fail" | "skipped";
  code?: number;
  timedOut?: boolean;
  // identifiers of individual failures; undefined when the output couldn't
  // be parsed and only the exit code is meaningful
  failures?: string[];
  output: string;
};

export type Baseline = {
  gitSha?: string;
  recordedAt: string;
  checks: Omit<CheckRun, "output">[];
};

export type CheckResult = {
  name: string;
  command: string;
  status: "pass" | "fail" | "skipped";
  newFailures: string[];
  fixedFailures: string[];
  preexisting: number;
  // failures that can't be compared because there's no baseline for them
  unknown?: string[];
  skipReason?: string;
  outputTail?: string;
};

export type VerifyResult = {
  baselineAt?: string;
  baselineSha?: string;
  checks: CheckResult[];
  ok: boolean;
};

const baselinePath = (projectRoot: string) =>
  path.join(stateDir(projectRoot), "baseline.json");

const stripAnsi = (s: string) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");

const tail = (output: string, lines = TAIL_LINES) =>
  output.trimEnd().split("\n").slice(-lines).join("\n");

// subprocess.run has no timeout or env, and a hung test runner must not hang
// the agent. Runs in its own process group so the whole tree can be killed.
const runWithTimeout = (
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; output: string; timedOut: boolean }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      env: { ...process.env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: stripAnsi(output), timedOut });
    });
  });

// line numbers shift as the agent edits, so errors are keyed without them
const typeErrorKey = (e: { path: string; message: string }) =>
  `${e.path} ${e.message
    .replace(/:\d+:\d+\b/g, "")
    .replace(/\(\d+,\d+\)/g, "")
    .replace(/\s+/g, " ")
    .trim()}`;

const DURATION = /\s*(\(\d+(\.\d+)?\s*m?s\)|\d+(\.\d+)?\s*m?s)\s*$/;

// Failing test identifiers from the common reporters:
//   jest/vitest  "FAIL src/a.test.ts", "✕ adds (3 ms)", "× adds 3ms"
//   node:test    "✖ adds (1.2ms)", TAP "not ok 3 - adds"
//   mocha        "  1) suite adds" under "N failing"
const parseTestFailures = (output: string): string[] => {
  const found: string[] = [];
  let inMochaFailing = false;
  for (const raw of output.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*\d+ failing\b/.test(line)) inMochaFailing = true;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*FAIL\s+(.+)$/))) {
      found.push(`FAIL ${m[1]!.replace(DURATION, "").trim()}`);
    } else if ((m = line.match(/^\s*[✕×✗✖]\s+(.+)$/))) {
      const name = m[1]!.replace(DURATION, "").trim();
      // node:test's summary repeats "✖ failing tests:" as a header
      if (!/^failing tests:?$/.test(name)) found.push(name);
    } else if ((m = line.match(/^\s*not ok \d+ - (.+?)(\s+#.*)?$/))) {
      found.push(m[1]!.trim());
    } else if (inMochaFailing && (m = line.match(/^\s{1,4}\d+\) (.+)$/))) {
      found.push(m[1]!.trim());
    }
  }
  return [...new Set(found)];
};

// eslint "stylish" and tsc-style diagnostics, the usual lint/build output
const parseLintOrBuildFailures = (output: string): string[] => {
  const found: string[] = [];
  let file = "";
  for (const line of output.split("\n")) {
    let m: RegExpMatchArray | null;
    if (/^\S.*\.[cm]?[jt]sx?$|^\/\S+$/.test(line.trim()) && !/\s/.test(line.trim())) {
      file = line.trim();
    } else if ((m = line.match(/^\s+\d+:\d+\s+(error)\s+(.+?)\s*$/))) {
      found.push(`${file} ${m[2]!.replace(/\s{2,}/g, " ")}`);
    } else if (
      (m = line.match(/^(.+?)(?::\d+:\d+ - |\(\d+,\d+\): )error (TS\d+: .*)$/))
    ) {
      found.push(typeErrorKey({ path: m[1]!, message: m[2]! }));
    }
  }
  return found;
};

const listScriptChecks = (projectRoot: string) => {
  const scripts = readPackageJson(projectRoot)?.scripts ?? {};
  const pm = findPackageManager(projectRoot);
  return SCRIPTS.filter((name) => scripts[name]).map((name) => {
    const script = scripts[name]!;
    const skipReason = LONG_RUNNING.test(script)
      ? `looks long-running: ${script}`
      : name === "test" && PLACEHOLDER_TEST.test(script)
        ? "placeholder test script"
        : undefined;
    return { name, command: runScriptCommand(pm, name), skipReason };
  });
};

const runTypecheck = async (
  projectRoot: string,
  checker: Checker,
): Promise<CheckRun> => {
  const base = { name: "typecheck", command: checker.command };
  try {
    const errors = await getBuildErrors(projectRoot, checker);
    return {
      ...base,
      status: errors.length > 0 ? "fail" : "pass",
      code: errors.length > 0 ? 1 : 0,
      failures: errors.map(typeErrorKey),
      output: errors
        .map(
          (e) =>
            `${e.path}:${e.line}:${e.column} ${e.message.replace(/\s*\n\s*/g, " ")}`,
        )
        .join("\n"),
    };
  } catch (e) {
    // the checker didn't run at all; only "it failed" is comparable
    return {
      ...base,
      status: "fail",
      code: 1,
      output: e instanceof Error ? e.message : String(e),
    };
  }
};

const runScriptCheck = async (
  projectRoot: string,
  check: { name: string; command: string },
  timeoutMs: number,
): Promise<CheckRun> => {
  const r = await runWithTimeout(check.command, projectRoot, timeoutMs);
  const failed = r.code !== 0 || r.timedOut;
  const parsed = failed
    ? check.name === "test"
      ? parseTestFailures(r.output)
      : parseLintOrBuildFailures(r.output)
    : [];
  return {
    ...check,
    status: failed ? "fail" : "pass",
    code: r.code,
    timedOut: r.timedOut || undefined,
    // a failure we couldn't itemize falls back to the exit code
    failures: !failed || parsed.length > 0 ? parsed : undefined,
    output: r.timedOut
      ? `${r.output}\n(killed after ${timeoutMs / 1000}s timeout)`
      : r.output,
  };
};

const runChecks = async (
  projectRoot: string,
  checker: Checker,
  options: VerifyOptions,
): Promise<CheckRun[]> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runs: CheckRun[] = [await runTypecheck(projectRoot, checker)];
  for (const check of listScriptChecks(projectRoot)) {
    runs.push(
      check.skipReason
        ? { ...check, status: "skipped", output: check.skipReason }
        : await runScriptCheck(projectRoot, check, timeoutMs),
    );
  }
  return runs;
};

const gitSha = async (projectRoot: string) => {
  const r = await run("git rev-parse HEAD", { cwd: projectRoot });
  return r.code === 0 ? r.stdout.trim() : undefined;
};

export const recordBaseline = async (
  projectRoot: string,
  checker: Checker,
  options: VerifyOptions = {},
): Promise<Baseline> => {
  const runs = await runChecks(projectRoot, checker, options);
  const baseline: Baseline = {
    gitSha: await gitSha(projectRoot),
    recordedAt: new Date().toISOString(),
    checks: runs.map(({ output: _, ...rest }) => rest),
  };
  writeFileSync(baselinePath(projectRoot), JSON.stringify(baseline, null, 2));
  return baseline;
};

export const readBaseline = (projectRoot: string): Baseline | undefined => {
  const file = baselinePath(projectRoot);
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf-8")) as Baseline)
    : undefined;
};

const counts = (items: string[]) => {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
};

// a - b as multisets, so a second identical error in one file still counts
const minus = (a: string[], b: string[]) => {
  const left = counts(b);
  return a.filter((i) => {
    const n = left.get(i) ?? 0;
    if (n > 0) left.set(i, n - 1);
    return n === 0;
  });
};

const compare = (
  now: CheckRun,
  before: Baseline["checks"][number] | undefined,
): CheckResult => {
  const result: CheckResult = {
    name: now.name,
    command: now.command,
    status: now.status,
    newFailures: [],
    fixedFailures: [],
    preexisting: 0,
  };
  if (now.status === "skipped") return { ...result, skipReason: now.output };

  const describeExit = (r: { code?: number; timedOut?: boolean }) =>
    r.timedOut ? "timed out" : `exit code ${r.code}`;

  if (!before || before.status === "skipped") {
    if (now.status === "fail") {
      result.unknown = now.failures?.length
        ? now.failures
        : [describeExit(now)];
      result.outputTail = tail(now.output);
    }
    return result;
  }

  if (now.failures && before.failures) {
    result.newFailures = minus(now.failures, before.failures);
    result.fixedFailures = minus(before.failures, now.failures);
    result.preexisting = now.failures.length - result.newFailures.length;
  } else if (now.status === "fail") {
    // at least one side is only an exit code; compare pass/fail
    if (before.status === "pass") {
      result.newFailures = [`${describeExit(now)} (was passing)`];
    } else {
      result.preexisting = 1;
    }
  } else if (before.status === "fail") {
    result.fixedFailures = [`now passing (was ${describeExit(before)})`];
  }

  if (result.newFailures.length > 0) {
    result.outputTail =
      now.name === "typecheck" && now.failures
        ? newTypeErrorLines(now, result.newFailures)
        : tail(now.output);
  }
  return result;
};

// the new errors with their current positions, so the agent can jump there
const newTypeErrorLines = (now: CheckRun, newKeys: string[]) => {
  const wanted = counts(newKeys);
  const lines = now.output.split("\n").filter((line) => {
    const m = line.match(/^(.+?):\d+:\d+ (.*)$/);
    if (!m) return false;
    const key = typeErrorKey({ path: m[1]!, message: m[2]! });
    const n = wanted.get(key) ?? 0;
    if (n > 0) wanted.set(key, n - 1);
    return n > 0;
  });
  return tail(lines.join("\n"));
};

export const verify = async (
  projectRoot: string,
  checker: Checker,
  options: VerifyOptions = {},
): Promise<VerifyResult> => {
  const baseline = readBaseline(projectRoot);
  const runs = await runChecks(projectRoot, checker, options);
  const checks = runs.map((r) =>
    compare(
      r,
      baseline?.checks.find((c) => c.name === r.name),
    ),
  );
  return {
    baselineAt: baseline?.recordedAt,
    baselineSha: baseline?.gitSha,
    checks,
    ok: checks.every(
      (c) => c.newFailures.length === 0 && (c.unknown?.length ?? 0) === 0,
    ),
  };
};

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

export const printVerify = (r: VerifyResult) => {
  if (!r.baselineAt) {
    console.log(
      "No baseline recorded (run `safebump verify baseline` before upgrading). " +
        "Failures below may or may not be caused by the upgrade.",
    );
  } else {
    console.log(
      `Compared with baseline from ${r.baselineAt}${r.baselineSha ? ` (${r.baselineSha.slice(0, 8)})` : ""}.`,
    );
  }

  const withNew = r.checks.filter((c) => c.newFailures.length > 0);
  for (const c of withNew) {
    console.log(`\n## ${c.name}: ${c.newFailures.length} NEW failure(s)  [${c.command}]`);
    // the type errors' tail already lists them with positions
    if (c.name !== "typecheck" || !c.outputTail) {
      for (const f of c.newFailures.slice(0, 30)) console.log(`- ${clip(f)}`);
      if (c.newFailures.length > 30) {
        console.log(`(+${c.newFailures.length - 30} more)`);
      }
    }
    if (c.outputTail) console.log(`\n${c.outputTail}`);
  }

  for (const c of r.checks.filter((c) => c.unknown?.length)) {
    console.log(`\n## ${c.name}: ${c.unknown!.length} failure(s), no baseline to compare  [${c.command}]`);
    for (const f of c.unknown!.slice(0, 30)) console.log(`- ${clip(f)}`);
    if (c.outputTail) console.log(`\n${c.outputTail}`);
  }

  console.log(`\n## Summary`);
  for (const c of r.checks) {
    const parts =
      c.status === "skipped"
        ? [`skipped (${c.skipReason})`]
        : [
            c.status,
            c.newFailures.length > 0 ? `${c.newFailures.length} new` : "",
            c.preexisting > 0 ? `${c.preexisting} pre-existing` : "",
            c.fixedFailures.length > 0 ? `${c.fixedFailures.length} fixed` : "",
            c.unknown?.length ? `${c.unknown.length} unknown whether new` : "",
          ].filter(Boolean);
    console.log(`- ${c.name}: ${parts.join(", ")}`);
  }
  console.log(
    r.ok
      ? "\nOK: the upgrade introduced no new failures."
      : withNew.length > 0
        ? "\nNOT OK: fix the new failures above."
        : "\nNOT OK: failures exist and there is no baseline to show they pre-date the upgrade.",
  );
};
