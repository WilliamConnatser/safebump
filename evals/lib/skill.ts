import path from "node:path";

import { run } from "./exec.ts";

/**
 * Thin wrapper over the skill's own CLI (`<skill>/scripts/safebump`). Every
 * deterministic check the harness makes goes through it, so the evals grade
 * with the same tools the agent is told to use.
 */
export type SkillResult = {
  /** false when this skill version has no such command */
  available: boolean;
  code: number | null;
  json: unknown;
  output: string;
  ms: number;
};

export const makeSkill = (skillDir: string, env: NodeJS.ProcessEnv) => {
  const bin = path.join(skillDir, "scripts", "safebump");
  return async (
    root: string,
    args: string[],
    opts: { log?: string; timeoutMs?: number } = {},
  ): Promise<SkillResult> => {
    const r = await run(bin, [...args, "--root", root, "--json"], {
      cwd: root,
      env,
      log: opts.log,
      timeoutMs: opts.timeoutMs ?? 30 * 60_000,
    });
    const output = r.stdout + r.stderr;
    // the CLI prints its usage and exits 2 for an unknown command
    const available = !(
      r.code === 2 && /Usage: safebump <command>/.test(output)
    );
    let json: unknown = undefined;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      // some commands print a line of text before the JSON, take the tail
      const start = r.stdout.search(/^[[{]/m);
      if (start >= 0) {
        try {
          json = JSON.parse(r.stdout.slice(start));
        } catch {
          /* not JSON */
        }
      }
    }
    return { available, code: r.code, json, output, ms: r.ms };
  };
};

export type Skill = ReturnType<typeof makeSkill>;

/** `safebump tsc --json` → number of errors, or null if the checker didn't produce JSON */
export const tscErrors = async (skill: Skill, root: string, log?: string) => {
  const r = await skill(root, ["tsc"], { log });
  if (!Array.isArray(r.json)) return { count: null, sample: [] as string[] };
  const errors = r.json as {
    path?: string;
    line?: number;
    message?: string;
  }[];
  return {
    count: errors.length,
    sample: errors
      .slice(0, 10)
      .map((e) => `${e.path}:${e.line} ${String(e.message).slice(0, 200)}`),
  };
};

/**
 * Interprets `verify --json`. Its schema is still being built, so accept the
 * likely shapes: {ok}, {newFailures|regressions: [...]}, or the exit code.
 */
export const interpretVerify = (r: SkillResult) => {
  if (!r.available) return { status: "unavailable" as const };
  const j = (r.json ?? {}) as Record<string, unknown>;
  const list = (k: string) => (Array.isArray(j[k]) ? (j[k] as unknown[]) : null);
  // current shape: {ok, checks: [{name, status, newFailures: [...]}]}
  const checks = list("checks") as { name?: string; newFailures?: unknown[] }[] | null;
  const perCheck = checks?.filter((c) => Array.isArray(c.newFailures));
  const newFailures =
    perCheck && perCheck.length > 0
      ? perCheck.flatMap((c) => c.newFailures!.map((f) => `${c.name}: ${String(f)}`))
      : (list("newFailures") ?? list("regressions") ?? null);
  let ok: boolean;
  if (typeof j.ok === "boolean") ok = j.ok;
  else if (newFailures) ok = newFailures.length === 0;
  else ok = r.code === 0;
  return {
    status: ok ? ("ok" as const) : ("failed" as const),
    newFailures: newFailures?.length ?? (ok ? 0 : null),
    failedChecks: checks?.filter((c) => (c.newFailures?.length ?? 0) > 0).map((c) => c.name) ?? [],
    detail: summarizeJson(r.json, r.output),
  };
};

/** Interprets `audit <ref> --json`: any finding counts as cheating. */
export const interpretAudit = (r: SkillResult) => {
  if (!r.available) return { status: "unavailable" as const };
  const j = r.json;
  const findings = Array.isArray(j)
    ? j
    : Array.isArray((j as { findings?: unknown })?.findings)
      ? ((j as { findings: unknown[] }).findings)
      : null;
  const count = findings ? findings.length : r.code === 0 ? 0 : null;
  return {
    status:
      count === 0
        ? ("clean" as const)
        : count === null
          ? ("error" as const)
          : ("findings" as const),
    findings: count,
    detail: summarizeJson(r.json, r.output),
  };
};

const summarizeJson = (json: unknown, output: string) =>
  (json === undefined ? output : JSON.stringify(json)).slice(0, 4000);
