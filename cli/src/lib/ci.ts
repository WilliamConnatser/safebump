import { readFileSync, writeFileSync } from "fs";
import path from "path";
import semver from "semver";

import { auditDiff } from "./audit";
import type { Checker } from "./checker";
import { getBuildErrors } from "./checker";
import { measureCoverage } from "./coverage";
import { findDuplicates, runDoctor } from "./doctor";
import { detectUpgrades, installedVersion } from "./packages";
import { planUpgrades } from "./plan";
import type { RiskReport } from "./risk-sites";
import { annotate, findRiskSites } from "./risk-sites";
import { run } from "./subprocess";
import { findTestGaps } from "./test-gaps";
import { readBaseline, verify } from "./verify";
import { diffImplementations } from "./impl-diff";
import { findApiUsage } from "./typescript/usage";
import { findWorkspaceRoot } from "./workspaces";
import type { SafebumpConfig } from "./config";
import { detectForge, MARKERS } from "./forge";
import { stateDir } from "./state";

// `safebump ci`: the deterministic assurance pass for a dependency-update PR
// (Renovate, Dependabot, a person). No agent, no LLM. It answers: is this
// upgrade complete, does it break anything, and is its risk proven by tests?

export type Risk = "low" | "medium" | "high";

export type CiFinding = {
  check: string;
  // "blocker" fails the required check; "risk" only raises the risk level
  severity: "blocker" | "risk" | "info";
  message: string;
  // true when the fix agent could resolve it
  fixable?: boolean;
};

export type CiReport = {
  base: string;
  upgrades: { name: string; from?: string; to?: string; updateType: "major" | "minor" | "patch" | "other" }[];
  risk: Risk;
  blocked: boolean;
  needsAgent: boolean;
  // which agent job the pipeline should run: "fix" when an agent can resolve
  // findings, "review" when nothing is broken or fixable but the risk is
  // medium or high, "none" for low risk or blockers only a human can resolve
  agentMode: "fix" | "review" | "none";
  findings: CiFinding[];
  riskSites?: RiskReport;
  markdown: string;
};

const git = (args: string, cwd: string) => run(`git ${args}`, { cwd });

// The version the base branch had installed, from its lockfile (npm), else
// the minimum of its declared range.
export const baseVersion = async (projectRoot: string, base: string, name: string) => {
  const lockRoot = findWorkspaceRoot(projectRoot) ?? projectRoot;
  const rel = path.relative(lockRoot, projectRoot);
  const lock = await git(`show ${base}:./package-lock.json`, lockRoot);
  if (lock.code === 0) {
    try {
      const packages = (JSON.parse(lock.stdout) as { packages?: Record<string, { version?: string }> }).packages ?? {};
      const hit =
        packages[`${rel ? `${rel}/` : ""}node_modules/${name}`]?.version ?? packages[`node_modules/${name}`]?.version;
      if (hit && semver.valid(hit)) return hit;
    } catch {
      // fall through to the declared range
    }
  }
  const manifest = await git(`show ${base}:./package.json`, projectRoot);
  if (manifest.code !== 0) return undefined;
  const pkg = JSON.parse(manifest.stdout) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const range = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
  try {
    return range ? semver.minVersion(range)?.version : undefined;
  } catch {
    return undefined;
  }
};

export const updateType = (from?: string, to?: string): CiReport["upgrades"][number]["updateType"] => {
  if (!from || !to || !semver.valid(from) || !semver.valid(to)) return "other";
  const diff = semver.diff(from, to);
  return diff === "major" || diff === "premajor"
    ? "major"
    : diff === "minor" || diff === "preminor"
      ? "minor"
      : "patch";
};

export const runCi = async (
  projectRoot: string,
  options: { base: string; checker: Checker; coverage?: boolean; timeoutMs?: number },
): Promise<CiReport> => {
  const findings: CiFinding[] = [];
  const add = (f: CiFinding) => findings.push(f);

  // what the branch bumped, and from what
  const bumped = await detectUpgrades(projectRoot, options.base);
  const upgrades = await Promise.all(
    bumped.map(async (u) => {
      const from = await baseVersion(projectRoot, options.base, u.packageName);
      const to = installedVersion(projectRoot, u.packageName);
      return { name: u.packageName, from, to, updateType: updateType(from, to) };
    }),
  );

  const doctor = await runDoctor(projectRoot, {
    packages: upgrades.map((u) => (u.to ? `${u.name}@${u.to}` : u.name)),
    checker: options.checker.source.startsWith("--checker") ? options.checker.command : undefined,
  });
  for (const c of doctor.checks.filter((c) => c.status === "fail")) {
    add({ check: "doctor", severity: "blocker", message: `${c.name}: ${c.detail}${c.fix ? ` (fix: ${c.fix})` : ""}` });
  }

  if (upgrades.length === 0) {
    add({ check: "detect", severity: "info", message: `No dependency versions changed relative to ${options.base}.` });
  }

  // did the bot bump the whole set? (peers, lockstep siblings, @types)
  if (upgrades.length > 0) {
    const plan = await planUpgrades(
      projectRoot,
      upgrades.filter((u) => u.to).map((u) => ({ name: u.name, spec: u.to })),
    );
    for (const c of plan.conflicts) add({ check: "plan", severity: "blocker", message: c });
    for (const p of plan.upgrades.filter((p) => !upgrades.some((u) => u.name === p.name))) {
      add({
        check: "plan",
        severity: "risk",
        fixable: true,
        message: `Incomplete upgrade set: ${p.name} ${p.from ?? "(not installed)"} → ${p.to} must move too (${p.reasons.join("; ")}).`,
      });
    }

    const dups = findDuplicates(projectRoot, upgrades.map((u) => u.name));
    for (const d of dups.duplicates) {
      add({
        check: "duplicates",
        severity: "risk",
        fixable: true,
        message: `${d.name} is installed in ${d.versions.length} versions: ${d.versions.map((v) => v.version).join(", ")}.`,
      });
    }
  }

  // nothing new broke: against the base-branch baseline when there is one
  if (readBaseline(projectRoot)) {
    const v = await verify(projectRoot, options.checker, { timeoutMs: options.timeoutMs });
    for (const c of v.checks) {
      if (c.newFailures.length > 0) {
        add({
          check: `verify:${c.name}`,
          severity: "blocker",
          fixable: true,
          message: `${c.newFailures.length} new ${c.name} failure(s) vs the base branch: ${c.newFailures.slice(0, 5).join("; ")}${c.newFailures.length > 5 ? "; …" : ""}`,
        });
      }
    }
  } else {
    const errors = await getBuildErrors(projectRoot, options.checker);
    add({ check: "verify", severity: "info", message: "No baseline from the base branch: only the type check was run, and tests/lint/build regressions weren't compared." });
    if (errors.length > 0) {
      add({ check: "typecheck", severity: "blocker", fixable: true, message: `${errors.length} type error(s).` });
    }
  }

  // nothing papered over: casts, suppressions, weakened tests in the PR's diff
  const mergeBase = (await git(`merge-base ${options.base} HEAD`, projectRoot)).stdout.trim() || options.base;
  const audit = await auditDiff(projectRoot, mergeBase);
  for (const f of audit.findings) {
    add({ check: "audit", severity: "blocker", message: `${f.file}:${f.line} ${f.rule}: ${f.text.trim()}` });
  }

  // the behavior changes, and whether tests prove them
  let riskSites: RiskReport | undefined;
  const analyzable = upgrades.filter((u) => u.from && u.to && u.from !== u.to);
  if (analyzable.length > 0) {
    const gaps = findTestGaps(projectRoot, analyzable.map((u) => u.name));
    const coverage =
      options.coverage === false
        ? undefined
        : await measureCoverage(projectRoot, {
            sourceFiles: gaps.files.map((f) => f.file),
            timeoutMs: options.timeoutMs,
          });
    if (coverage && !coverage.available) {
      add({ check: "coverage", severity: "info", message: `Runtime coverage unavailable (${coverage.reason ?? "unknown"}); risk sites judged by static reachability.` });
    }
    riskSites = annotate(
      await findRiskSites(projectRoot, gaps, analyzable.map((u) => ({ name: u.name, from: u.from, to: u.to! }))),
      gaps,
      coverage,
    );
    for (const s of riskSites.sites.filter((s) => s.status !== "executed")) {
      add({
        check: "risk-sites",
        severity: "risk",
        fixable: true,
        message: `${s.file}:${s.line}${s.symbol ? ` ${s.symbol}` : ""} isn't executed by any test: ${s.reasons.map((r) => r.detail).join("; ")}`,
      });
    }
    for (const n of riskSites.notes) add({ check: "risk-sites", severity: "info", message: n });

    // behavior changes in the dependency's own code, for the APIs used here
    const BEHAVIOR = new Set(["default-changed", "constant-changed", "new-throw", "branch-removed"]);
    for (const u of analyzable) {
      const used = findApiUsage(projectRoot, u.name).uses.filter((x) => !x.typeOnly && !x.testOnly);
      if (used.length === 0) continue;
      const impl = await diffImplementations(
        projectRoot,
        u.name,
        u.from!,
        u.to!,
        used.slice(0, 25).map((x) => ({ api: x.api, owner: x.owner, member: x.member })),
      ).catch(() => undefined);
      for (const d of impl?.diffs ?? []) {
        // flags inside newly added functions describe new features (they only
        // run if the project opts in); the brief keeps them for the reviewer
        // a changed default can't affect an option the project always sets
        // (an unconditional `maxRetries: 2`); conditionally set ones stay
        const setOptions = new Set(
          used.filter((x) => x.kinds.includes("option") && x.member).map((x) => x.member!),
        );
        const overridden = (detail: string) => {
          const m = /`(?:options|opts|config|params|clientOptions)\.(\w+) (?:\?\?|\|\|)/.exec(detail);
          return !!m && setOptions.has(m[1]!);
        };
        const flags = d.flags.filter(
          (f) => BEHAVIOR.has(f.kind) && !/\bin new\b/.test(f.detail) && !(f.kind === "default-changed" && overridden(f.detail)),
        );
        if (flags.length === 0) continue;
        add({
          check: "implementation",
          severity: "risk",
          message: `${u.name} \`${d.api}\` changed behavior in its source: ${flags.slice(0, 4).map((f) => `${f.kind} ${f.detail}`).join("; ")}${flags.length > 4 ? "; …" : ""}`,
        });
      }
    }
  }

  const blocked = findings.some((f) => f.severity === "blocker");
  const openRisks = findings.filter((f) => f.severity === "risk");
  const hasMajor = upgrades.some((u) => u.updateType === "major" || u.updateType === "other");
  const risk: Risk =
    blocked || (hasMajor && openRisks.length > 0)
      ? "high"
      : hasMajor || openRisks.length > 0
        ? "medium"
        : "low";
  const needsAgent = findings.some((f) => f.fixable && f.severity !== "info");
  const humanOnly = findings.some((f) => f.severity === "blocker" && !f.fixable);
  const agentMode: CiReport["agentMode"] = needsAgent && !humanOnly
    ? "fix"
    : !blocked && risk !== "low"
      ? "review"
      : "none";

  const report: Omit<CiReport, "markdown"> = { base: options.base, upgrades, risk, blocked, needsAgent, agentMode, findings, riskSites };
  return { ...report, markdown: renderMarkdown(report) };
};

const ICON: Record<CiFinding["severity"], string> = { blocker: "🛑", risk: "⚠️", info: "ℹ️" };

const renderMarkdown = (r: Omit<CiReport, "markdown">) => {
  const verdict = r.blocked
    ? "🛑 **Blocked**: this upgrade breaks something. Don't merge until it's fixed."
    : r.risk === "low"
      ? `✅ **Low risk**: complete, nothing new broke, and ${r.riskSites && r.riskSites.sites.length > 0 ? "every risky call site runs under passing tests" : "no call sites in this project are affected by API or default changes"}. Eligible to auto-merge.`
      : r.risk === "medium"
        ? "⚠️ **Medium risk**: nothing broke, but this needs a human review before merging."
        : "⚠️ **High risk**: a major upgrade with unproven behavior changes. Review the items below.";
  const lines = [
    "## safebump",
    "",
    verdict,
    "",
    r.upgrades.length > 0
      ? ["| Package | From | To | Update |", "|---|---|---|---|", ...r.upgrades.map((u) => `| \`${u.name}\` | ${u.from ?? "?"} | ${u.to ?? "?"} | ${u.updateType} |`)].join("\n")
      : `No dependency versions changed relative to \`${r.base}\`.`,
    "",
  ];
  const shown = r.findings.filter((f) => f.severity !== "info");
  if (shown.length > 0) {
    lines.push("### Findings", "", ...shown.map((f) => `- ${ICON[f.severity]} **${f.check}**: ${f.message}`), "");
  }
  const info = r.findings.filter((f) => f.severity === "info");
  if (info.length > 0) {
    lines.push("<details><summary>Notes</summary>", "", ...info.map((f) => `- ${f.message}`), "", "</details>", "");
  }
  if (r.agentMode === "fix") {
    lines.push("_The fixable findings above can be handled by the safebump agent job._", "");
  } else if (r.agentMode === "review") {
    lines.push("_An agent review will judge these changes against the APIs this project uses and the release notes._", "");
  }
  return lines.join("\n");
};

export const printCi = (r: CiReport) => console.log(r.markdown);

// whether an agent runs at all is the repo's choice (safebump.yml): the
// deterministic verdict only says what kind of agent help would apply
export const effectiveAgentMode = (r: CiReport, config: SafebumpConfig): CiReport["agentMode"] => {
  if (config.mode !== "ai" || !config.ai) return "none";
  if (r.agentMode === "fix") return config.ai.fix.enabled ? "fix" : "none";
  if (r.agentMode === "review") {
    const review = config.ai.review;
    if (!review.enabled) return "none";
    if (review.minRisk === "high" && r.risk !== "high") return "none";
    if (review.skipPatch && r.upgrades.every((u) => u.updateType === "patch")) return "none";
    return "review";
  }
  return "none";
};

const reportFile = (projectRoot: string) => path.join(stateDir(projectRoot), "ci-report.json");

export const saveCiReport = (projectRoot: string, r: CiReport) =>
  writeFileSync(reportFile(projectRoot), JSON.stringify(r, null, 2));

export const loadCiReport = (projectRoot: string): CiReport | undefined => {
  try {
    return JSON.parse(readFileSync(reportFile(projectRoot), "utf-8")) as CiReport;
  } catch {
    return undefined;
  }
};

// the sticky comment and the two statuses: `safebump` (required; red only
// when broken) and `safebump/automerge` (not required; green only when the
// deterministic checks prove low risk)
export const postCi = async (r: CiReport, sha?: string, options: { agentChanged?: boolean } = {}) => {
  const forge = detectForge();
  if (!forge) {
    console.error("--post: not running in GitHub Actions or a GitLab merge request pipeline; nothing posted");
    return;
  }
  await forge.upsertComment(MARKERS.ci, r.markdown);
  await forge.setStatus(
    "safebump",
    r.blocked ? "failure" : "success",
    r.blocked ? "Blocked: see the safebump comment" : `Not broken (risk: ${r.risk})`,
    sha,
  );
  const automerge = !r.blocked && r.risk === "low" && !options.agentChanged;
  await forge.setStatus(
    "safebump/automerge",
    automerge ? "success" : "failure",
    options.agentChanged
      ? "Changed by the safebump agent: needs a human review"
      : automerge
        ? "Low risk: eligible to auto-merge"
        : `Risk ${r.risk}: needs a human review`,
    sha,
  );
};
