import { writeFileSync } from "fs";
import path from "path";
import semver from "semver";

import { auditDiff } from "./audit";
import { saveCheckpoint } from "./checkpoint";
import type { CoverageResult } from "./coverage";
import { installedVersion } from "./packages";
import { stateDir } from "./state";
import { findDeprecations } from "./deprecations";
import type { TestGaps } from "./test-gaps";
import { diffApi, isRelevantBehavior } from "./typescript/apidiff";
import { findDefaultReliance } from "./typescript/defaults";

// The call sites an upgrade is most likely to break, scored, so test gaps are
// filled where they matter: a call that omits an option whose default
// changed outranks a heavily used API that didn't change at all.

export type RiskReason = {
  kind: "removed-api" | "changed-api" | "behavior" | "default" | "deprecated";
  detail: string;
  weight: number;
};

export type SiteStatus =
  // a test ran this line (runtime coverage)
  | "executed"
  // tests loaded the file but never ran this line
  | "not-executed"
  // no test loaded the file
  | "unreached"
  // no runtime coverage: only static reachability is known
  | "reachable-static"
  | "unreachable-static";

export type RiskSite = {
  package: string;
  file: string;
  line: number;
  symbol?: string;
  reasons: RiskReason[];
  weight: number;
  status?: SiteStatus;
};

export type RiskReport = {
  targets: { name: string; from?: string; to: string }[];
  sites: RiskSite[];
  notes: string[];
};

const WEIGHT = {
  removedApi: 5,
  removedMember: 5,
  defaultOmitted: 5,
  signature: 4,
  deprecated: 4,
  behavior: 3,
  defaultSpread: 3,
  defaultParent: 2,
} as const;

export const findRiskSites = async (
  projectRoot: string,
  gaps: TestGaps,
  // `from` defaults to the installed version; on a branch that's already
  // bumped (a bot's PR) pass the base branch's version instead
  targets: { name: string; from?: string; to: string }[],
  options: { deprecations?: boolean } = {},
): Promise<RiskReport> => {
  const sites = new Map<string, RiskSite>();
  const notes: string[] = [];
  const resolved: RiskReport["targets"] = [];

  const add = (pkg: string, file: string, line: number, reason: RiskReason, symbol?: string) => {
    const key = `${file}:${line}`;
    const site = sites.get(key) ?? { package: pkg, file, line, symbol, reasons: [], weight: 0 };
    if (!site.reasons.some((r) => r.detail === reason.detail)) {
      site.reasons.push(reason);
      site.weight += reason.weight;
    }
    sites.set(key, site);
  };

  for (const target of targets) {
    // what the project calls, and on which lines (from the static scan)
    const usages = gaps.files
      .filter((f) => f.packages.includes(target.name))
      .flatMap((f) => f.usages.map((u) => ({ file: f.file, ...u })));

    const diff = await diffApi(projectRoot, target.name, target.from, target.to).catch((e: unknown) => {
      notes.push(`${target.name}: API diff failed (${e instanceof Error ? e.message : String(e)})`);
      return undefined;
    });
    resolved.push({ name: target.name, from: diff?.from, to: diff?.to ?? target.to });

    if (diff) {
      const names = new Set(diff.symbols.map((s) => s.name));
      for (const s of diff.symbols) {
        const reasons: RiskReason[] = [];
        // default imports are known by their local name, e.g. OpenAI
        const label =
          s.name === "default"
            ? `${usages.find((u) => !names.has(u.symbol.split(".")[0]!))?.symbol.split(".")[0] ?? "default"} (default export)`
            : s.name;
        if (s.status === "removed") {
          reasons.push({ kind: "removed-api", detail: `${label} no longer exported in ${diff.to}`, weight: WEIGHT.removedApi });
        }
        if (s.signatureChanged) {
          reasons.push({ kind: "changed-api", detail: `${label} signature changed`, weight: WEIGHT.signature });
        }
        if (s.deprecated) {
          reasons.push({ kind: "deprecated", detail: `${label} deprecated: ${s.deprecated.slice(0, 120)}`, weight: WEIGHT.deprecated });
        }
        for (const m of s.members) {
          if (m.kind === "removed" && m.mentioned) {
            reasons.push({ kind: "removed-api", detail: `${m.type}.${m.member} removed`, weight: WEIGHT.removedMember });
          } else if (isRelevantBehavior(m)) {
            reasons.push({ kind: "behavior", detail: `${m.type}.${m.member}: ${m.kind} changed`, weight: WEIGHT.behavior });
          }
        }
        if (reasons.length === 0) continue;

        // a default import is used under its local name, which is any name
        // that isn't one of the package's named imports
        const matches = usages.filter((u) =>
          s.name === "default"
            ? !names.has(u.symbol.split(".")[0]!)
            : u.symbol === s.name || u.symbol.split(".").pop() === s.name,
        );
        for (const u of matches) for (const r of reasons) add(target.name, u.file, u.line, r, u.symbol);
      }
    }

    const defaults = await findDefaultReliance(projectRoot, target.name, target.from, target.to).catch(
      (e: unknown) => {
        notes.push(`${target.name}: default analysis failed (${e instanceof Error ? e.message : String(e)})`);
        return undefined;
      },
    );
    for (const change of defaults?.changes ?? []) {
      for (const site of change.sites) {
        const weight =
          site.status === "omitted"
            ? WEIGHT.defaultOmitted
            : site.status === "spread-unknown"
              ? WEIGHT.defaultSpread
              : WEIGHT.defaultParent;
        add(
          target.name,
          site.file,
          site.line,
          {
            kind: "default",
            detail: `${change.owner}.${change.member} default ${change.oldDefault ?? "?"} → ${change.newDefault ?? "?"} (${site.status})`,
            weight,
          },
          site.call,
        );
      }
    }
  }

  if (options.deprecations) {
    const report = findDeprecations(projectRoot, targets.map((t) => t.name));
    for (const use of report.uses) {
      add(use.package, use.file, use.line, {
        kind: "deprecated",
        detail: `${use.symbol} deprecated${use.message ? `: ${use.message.slice(0, 120)}` : ""}`,
        weight: WEIGHT.deprecated,
      }, use.symbol);
    }
  }

  return {
    targets: resolved,
    sites: Array.from(sites.values()).sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file) || a.line - b.line),
    notes,
  };
};

// Exact line: both coverage formats already resolve a line inside a
// multi-line call to its innermost statement. A window would be wrong here,
// because the declaration line above a call (`const f = () =>`) counts as
// executed as soon as the module loads.
const NEAR_BEFORE = 0;
const NEAR_AFTER = 0;

export const siteStatus = (
  site: { file: string; line: number },
  gaps: TestGaps,
  coverage?: CoverageResult,
): SiteStatus => {
  if (coverage?.available) {
    if (!coverage.files.includes(site.file)) return "unreached";
    const lines = new Set(coverage.executed[site.file] ?? []);
    for (let l = site.line - NEAR_BEFORE; l <= site.line + NEAR_AFTER; l++) {
      if (lines.has(l)) return "executed";
    }
    return "not-executed";
  }
  const file = gaps.files.find((f) => f.file === site.file);
  return file?.covered && !file.mockedOnly ? "reachable-static" : "unreachable-static";
};

export const annotate = (report: RiskReport, gaps: TestGaps, coverage?: CoverageResult) => {
  for (const site of report.sites) site.status = siteStatus(site, gaps, coverage);
  return report;
};

const LABEL: Record<SiteStatus, string> = {
  executed: "✔ executed by tests",
  "not-executed": "✖ file loaded by tests, line never run",
  unreached: "✖ no test loads this file",
  "reachable-static": "? a test imports the file (run with --coverage to know if this line runs)",
  "unreachable-static": "✖ no test reaches this file",
};

export const printRiskReport = (report: RiskReport) => {
  const targets = report.targets.map((t) => `${t.name} ${t.from ?? "?"} → ${t.to}`).join(", ");
  if (report.sites.length === 0) {
    console.log(`\n## Risk sites (${targets})\nNone found: no removed, changed or behavior-changed APIs and no changed defaults at this project's call sites.`);
  } else {
    const open = report.sites.filter((s) => s.status !== "executed");
    console.log(
      `\n## Risk sites (${targets}): ${report.sites.length}, ${open.length} not proven by tests. Highest risk first.`,
    );
    for (const s of report.sites) {
      console.log(`- ${s.file}:${s.line}${s.symbol ? ` ${s.symbol}` : ""} [risk ${s.weight}] ${s.status ? LABEL[s.status] : ""}`);
      for (const r of s.reasons) console.log(`    ${r.detail}`);
    }
  }
  for (const n of report.notes) console.log(`note: ${n}`);
};

export type Confirmation = {
  ok: boolean;
  failures: string[];
  checkpoint?: number;
  recordedAt?: string;
};

// The gate before upgrading: the risky call sites are proven to run under
// tests that pass on the version installed now.
export const confirmCoverage = async (
  projectRoot: string,
  report: RiskReport,
  coverage: CoverageResult,
): Promise<Confirmation> => {
  const failures: string[] = [];
  if (!coverage.available) {
    failures.push(`runtime coverage unavailable: ${coverage.reason ?? "unknown reason"}`);
  } else if (!coverage.testsPassed) {
    failures.push("the tests fail on the current version; characterization tests must pass before upgrading");
  }
  for (const t of report.targets) {
    const installed = installedVersion(projectRoot, t.name);
    if (installed && semver.valid(installed) && semver.valid(t.to) && semver.gte(installed, t.to)) {
      failures.push(`${t.name} is already at ${installed}: confirm on the old version, before upgrading`);
    }
  }
  const open = report.sites.filter((s) => s.status !== "executed");
  if (coverage.available) {
    for (const s of open) {
      failures.push(`not executed by any test: ${s.file}:${s.line}${s.symbol ? ` ${s.symbol}` : ""} (${s.reasons.map((r) => r.detail).join("; ")})`);
    }
  }
  if (failures.length > 0) return { ok: false, failures };

  const cp = await saveCheckpoint(projectRoot, "characterization tests confirmed", {
    audit: (await auditDiff(projectRoot, "HEAD")).findings.length,
  });
  const recordedAt = new Date().toISOString();
  writeFileSync(
    path.join(stateDir(projectRoot), "coverage-confirmed.json"),
    JSON.stringify({ recordedAt, checkpoint: cp.id, runner: coverage.runner, targets: report.targets, sites: report.sites }, null, 2),
  );
  return { ok: true, failures: [], checkpoint: cp.id, recordedAt };
};

export const printConfirmation = (c: Confirmation) => {
  if (c.ok) {
    console.log(`\n✔ Confirmed: every risk site runs under passing tests on the current version. Checkpoint #${c.checkpoint} saved; recorded in .safebump/coverage-confirmed.json. Safe to apply the upgrade.`);
    return;
  }
  console.log(`\n✖ Not confirmed (${c.failures.length}):`);
  for (const f of c.failures) console.log(`- ${f}`);
};
