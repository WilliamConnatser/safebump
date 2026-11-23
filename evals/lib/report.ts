import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Usage } from "./agents.ts";
import type { DiffStats } from "./score.ts";
import { LEGACY_EVAL_URL, loadJson } from "./tasks.ts";

export type TaskResult = {
  id: string;
  package: string;
  versionTo: string;
  source: string;
  agent: string;
  startedAt: string;
  status: "scored" | "error";
  error?: string;
  setup?: {
    pkgManager: string;
    installCommand: string;
    nodeWarning?: string;
    ms: number;
  };
  baseline?: {
    tscErrors: number | null;
    tscSample: string[];
    /** `verify baseline`: recorded | unavailable (command missing) | failed */
    verify: string;
    ms: number;
  };
  agentRun?: {
    skipped: boolean;
    exitCode: number | null;
    timedOut: boolean;
    ms: number;
    usage: Usage;
    reportWritten: boolean;
  };
  score?: {
    installedVersion: string | null;
    atTarget: boolean;
    tscErrors: number | null;
    tscSample: string[];
    /** zero errors, or (when the baseline already had errors) no more than before */
    typecheckClean: boolean;
    verify: { status: string; newFailures?: number | null; failedChecks?: (string | undefined)[]; detail?: string };
    audit: { status: string; findings?: number | null; detail?: string };
    diff: DiffStats;
    ms: number;
  };
  pass: boolean;
  /** the original swe-bump-bench grading: errors after <= errors before */
  legacyPass: boolean;
};

export const readResults = (dir: string): TaskResult[] => {
  const file = path.join(dir, "results.jsonl");
  if (!existsSync(file)) return [];
  const byId = new Map<string, TaskResult>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as TaskResult;
    byId.set(r.id, r); // a re-run of a task replaces the earlier line
  }
  return [...byId.values()];
};

const median = (xs: number[]) => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}% (${n}/${d})`);
const mins = (ms?: number) => (ms === undefined ? "-" : `${(ms / 60_000).toFixed(1)}m`);
const usd = (x?: number) => (x === undefined ? "-" : `$${x.toFixed(2)}`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export const summarize = (results: TaskResult[], config: Record<string, unknown> = {}) => {
  const scored = results.filter((r) => r.status === "scored");
  const harnessErrors = results.filter((r) => r.status === "error");
  const passed = results.filter((r) => r.pass);
  const rate = (f: (r: TaskResult) => boolean) => pct(scored.filter(f).length, scored.length);
  const agentMs = scored.flatMap((r) => (r.agentRun && !r.agentRun.skipped ? [r.agentRun.ms] : []));
  const costs = scored.flatMap((r) => (r.agentRun?.usage.costUsd !== undefined ? [r.agentRun.usage.costUsd] : []));
  const tokens = scored.flatMap((r) => {
    const u = r.agentRun?.usage;
    return u?.inputTokens !== undefined || u?.outputTokens !== undefined
      ? [(u.inputTokens ?? 0) + (u.outputTokens ?? 0)]
      : [];
  });
  const dirtyBaseline = scored.filter((r) => (r.baseline?.tscErrors ?? 0) > 0);
  const verifyAvailable = scored.some((r) => r.score?.verify.status !== "unavailable");
  const auditAvailable = scored.some((r) => r.score?.audit.status !== "unavailable");

  const lines = [
    `# safebump eval: ${config.agent ?? "?"}${config.dryRun ? " (dry run, agent not invoked)" : ""}`,
    "",
    ...Object.entries(config)
      .filter(([k]) => ["agent", "agentCmd", "skill", "skillVersion", "tasks", "startedAt", "node"].includes(k))
      .map(([k, v]) => `- ${k}: \`${String(v)}\``),
    "",
    "## Result",
    "",
    `**Pass rate: ${pct(passed.length, results.length)}** of all tasks; ${pct(passed.length, scored.length)} of tasks the harness could score.`,
    "",
    "A task passes iff the target version is installed, the type check is clean, `verify` reports no new failures and `audit` reports no findings.",
    String(config.tasks ?? "").includes("swe-bump-bench")
      ? "\nReference: the original (pre-skill) bumpgen scored 45% (28/62) on swe-bump-bench under its legacy grading (`tsc` errors after <= before)."
      : "",
    "",
    "| Criterion | Rate (of scored tasks) |",
    "|---|---|",
    `| target version installed | ${rate((r) => !!r.score?.atTarget)} |`,
    `| type check clean | ${rate((r) => !!r.score?.typecheckClean)} |`,
    `| verify: no new failures | ${verifyAvailable ? rate((r) => r.score?.verify.status === "ok") : "n/a (skill has no \`verify\`)"} |`,
    `| audit: no findings | ${auditAvailable ? rate((r) => r.score?.audit.status === "clean") : "n/a (skill has no \`audit\`)"} |`,
    `| legacy swe-bump-bench grading | ${rate((r) => r.legacyPass)} |`,
    `| agent exited 0 | ${rate((r) => r.agentRun?.exitCode === 0)} |`,
    `| agent timed out | ${rate((r) => !!r.agentRun?.timedOut)} |`,
    `| report written | ${rate((r) => !!r.agentRun?.reportWritten)} |`,
    "",
    `- Harness errors (clone, install, baseline or scoring threw): ${harnessErrors.length}`,
    `- Tasks whose baseline already had type errors: ${dirtyBaseline.length} (graded as "no more errors than before")`,
    `- Median agent wall time: ${mins(median(agentMs))}`,
    `- Median cost: ${usd(median(costs))}, total: ${costs.length ? usd(costs.reduce((a, b) => a + b, 0)) : "-"} (${costs.length} task(s) reported cost)`,
    `- Median tokens (in+out): ${median(tokens)?.toLocaleString() ?? "-"}`,
    "",
    "## Tasks",
    "",
    "| Task | Pass | Installed | tsc before→after | verify | audit | Diff (files, +/-) | Agent time | Cost | Notes |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...results
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => {
        const s = r.score;
        const notes = [
          r.error,
          r.setup?.nodeWarning,
          r.agentRun?.timedOut ? "timed out" : undefined,
          r.agentRun && !r.agentRun.skipped && r.agentRun.exitCode !== 0 ? `agent exit ${r.agentRun.exitCode}` : undefined,
        ]
          .filter(Boolean)
          .join("; ");
        return `| ${cell(r.id)} | ${r.pass ? "PASS" : r.status === "error" ? "ERROR" : "fail"} | ${s ? `${s.installedVersion ?? "missing"}${s.atTarget ? "" : " ✗"}` : "-"} | ${r.baseline?.tscErrors ?? "?"}→${s?.tscErrors ?? "?"} | ${s ? `${s.verify.status}${s.verify.failedChecks?.length ? ` (${s.verify.failedChecks.join(", ")})` : ""}` : "-"} | ${s ? `${s.audit.status}${s.audit.findings ? ` (${s.audit.findings})` : ""}` : "-"} | ${s ? `${s.diff.files}, +${s.diff.added}/-${s.diff.removed}` : "-"} | ${r.agentRun?.skipped ? "skipped" : mins(r.agentRun?.ms)} | ${usd(r.agentRun?.usage.costUsd)} | ${cell(notes.slice(0, 300))} |`;
      }),
    "",
  ];
  return lines.join("\n");
};

type Outcome = { pass: boolean; label: string };

/** A results dir, or `legacy` for the original bumpgen's swe-bump-bench run. */
export const loadOutcomes = async (source: string) => {
  const map = new Map<string, Outcome>();
  if (source === "legacy") {
    for (const e of (await loadJson(LEGACY_EVAL_URL)) as { id: string; state: string }[]) {
      map.set(e.id, { pass: e.state === "SUCCESS", label: e.state === "SUCCESS" ? "PASS" : "fail" });
    }
    return { name: "legacy bumpgen (swe-bump-bench eval.json)", map };
  }
  for (const r of readResults(source)) {
    map.set(r.id, { pass: r.pass, label: r.pass ? "PASS" : r.status === "error" ? "ERROR" : "fail" });
  }
  const cfgFile = path.join(source, "config.json");
  const cfg = existsSync(cfgFile) ? (JSON.parse(readFileSync(cfgFile, "utf8")) as { agent?: string; dryRun?: boolean }) : {};
  return { name: `${source}${cfg.agent ? ` (${cfg.agent}${cfg.dryRun ? ", dry run" : ""})` : ""}`, map };
};

export const compare = async (a: string, b: string) => {
  const A = await loadOutcomes(a);
  const B = await loadOutcomes(b);
  const common = [...A.map.keys()].filter((id) => B.map.has(id)).sort();
  const passA = common.filter((id) => A.map.get(id)!.pass).length;
  const passB = common.filter((id) => B.map.get(id)!.pass).length;
  const fixed = common.filter((id) => !A.map.get(id)!.pass && B.map.get(id)!.pass);
  const broke = common.filter((id) => A.map.get(id)!.pass && !B.map.get(id)!.pass);
  const allA = [...A.map.values()].filter((o) => o.pass).length;
  const allB = [...B.map.values()].filter((o) => o.pass).length;
  return [
    `# Compare`,
    "",
    `- A: ${A.name}`,
    `- B: ${B.name}`,
    "",
    "| | A | B |",
    "|---|---|---|",
    `| pass rate, all tasks | ${pct(allA, A.map.size)} | ${pct(allB, B.map.size)} |`,
    `| pass rate, ${common.length} common tasks | ${pct(passA, common.length)} | ${pct(passB, common.length)} |`,
    "",
    `Net: ${passB - passA >= 0 ? "+" : ""}${passB - passA} task(s) on the common set (${fixed.length} newly passing, ${broke.length} newly failing).`,
    "",
    ...(fixed.length + broke.length > 0
      ? [
          "| Task | A | B |",
          "|---|---|---|",
          ...[...fixed, ...broke].map((id) => `| ${cell(id)} | ${A.map.get(id)!.label} | ${B.map.get(id)!.label} |`),
        ]
      : ["No per-task flips."]),
    "",
    ...(common.length < Math.max(A.map.size, B.map.size)
      ? [`Only in A: ${A.map.size - common.length}, only in B: ${B.map.size - common.length}.`, ""]
      : []),
  ].join("\n");
};
