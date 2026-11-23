import semver from "semver";

import type { UpgradePlan } from "./plan";
import { planUpgrades } from "./plan";
import type { ApiDiff } from "./typescript/apidiff";
import { collectImports, diffApi, summarizeSymbol } from "./typescript/apidiff";

// Blast radius of an upgrade before anything is installed: which planned
// packages the code imports, from how many places, and how much of the API
// it uses differs between the installed and planned versions.

export type Risk = "low" | "medium" | "high";

export type PackageImpact = {
  name: string;
  from?: string;
  to: string;
  majorsCrossed: number;
  importingFiles: number;
  importSites: number;
  symbolsUsed: number;
  // imported names, by what happened to them
  removed: string[];
  changed: string[];
  // compiles, but defaults/deprecations/docs changed on something used
  behaviorChanged: string[];
  // option/result members that went away and the project mentions by name
  removedMembersMentioned: string[];
  // imported names that couldn't be resolved in the installed version
  uncompared: string[];
  risk: Risk;
  reasons: string[];
  // the API diff couldn't be computed (no types, network, ...)
  error?: string;
};

export type ImpactReport = {
  packages: PackageImpact[];
  total: {
    packages: number;
    importingFiles: number;
    importSites: number;
    removed: number;
    changed: number;
    behaviorChanged: number;
  };
  risk: Risk;
  reasons: string[];
  majorsCrossed: { name: string; from: string; to: string }[];
  conflicts: string[];
  notes: string[];
};

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
const max = (a: Risk, b: Risk) => (RANK[a] >= RANK[b] ? a : b);

// thresholds: a handful of files is a quick fix, dozens need planning
const MANY_FILES = 15;

const majorsBetween = (from: string | undefined, to: string) =>
  from && semver.valid(from) && semver.valid(to) ? semver.major(to) - semver.major(from) : 0;

const assess = (p: Omit<PackageImpact, "risk" | "reasons">) => {
  const reasons: string[] = [];
  let risk: Risk = "low";
  const raise = (to: Risk, why: string) => {
    risk = max(risk, to);
    reasons.push(why);
  };

  if (p.importSites === 0) {
    reasons.push("not imported by the project's source");
    return { risk, reasons };
  }
  if (p.error) raise("medium", `API diff unavailable: ${p.error}`);
  if (p.removed.length > 0) raise("high", `${p.removed.length} imported name(s) removed: ${p.removed.join(", ")}`);
  if (p.removedMembersMentioned.length > 0) {
    raise("high", `removed option/result members mentioned in the code: ${p.removedMembersMentioned.join(", ")}`);
  }
  if (p.behaviorChanged.length > 0) {
    raise("medium", `behavior/docs changed on ${p.behaviorChanged.join(", ")} (compiles, may act differently)`);
  }
  if (p.changed.length > 0) {
    raise(
      p.importingFiles >= MANY_FILES ? "high" : "medium",
      `${p.changed.length}/${p.symbolsUsed} imported name(s) changed, across ${p.importingFiles} file(s)`,
    );
  }
  if (p.uncompared.length > 0) {
    raise("medium", `couldn't compare ${p.uncompared.join(", ")} (not found in the installed version's types)`);
  }
  if (p.majorsCrossed > 1) raise("medium", `crosses ${p.majorsCrossed} major versions`);
  if (reasons.length === 0) reasons.push("no differences in the API the project uses");
  return { risk, reasons };
};

export const previewImpact = async (
  projectRoot: string,
  targets: { name: string; spec?: string }[],
): Promise<ImpactReport & { plan: UpgradePlan }> => {
  const plan = await planUpgrades(projectRoot, targets);
  // @types/x is used through imports of x
  const importName = (name: string) =>
    name.startsWith("@types/")
      ? name.slice(7).includes("__")
        ? `@${name.slice(7).replace("__", "/")}`
        : name.slice(7)
      : name;
  const imports = collectImports(
    projectRoot,
    Array.from(new Set(plan.upgrades.map((u) => importName(u.name)))),
  );

  const packages: PackageImpact[] = [];
  for (const u of plan.upgrades) {
    const used = imports.get(importName(u.name))!;
    const base = {
      name: u.name,
      from: u.from,
      to: u.to,
      majorsCrossed: majorsBetween(u.from, u.to),
      importingFiles: used.files.length,
      importSites: used.sites,
      symbolsUsed: used.symbols.length,
      removed: [] as string[],
      changed: [] as string[],
      behaviorChanged: [] as string[],
      removedMembersMentioned: [] as string[],
      uncompared: [] as string[],
      error: undefined as string | undefined,
    };

    // diffs are per runtime package; an @types bump alone isn't diffed
    const isTypes = u.name.startsWith("@types/");
    if (isTypes && used.sites > 0) {
      base.error = `API diff not computed for @types packages; see ${importName(u.name)}`;
    }
    if (used.sites > 0 && u.from && !isTypes) {
      let diff: ApiDiff | undefined;
      try {
        diff = await diffApi(
          projectRoot,
          u.name,
          u.from,
          u.to,
          { imports: used },
        );
      } catch (e) {
        base.error = e instanceof Error ? e.message : String(e);
      }
      for (const s of diff?.symbols ?? []) {
        const sum = summarizeSymbol(s);
        if (sum.removed) base.removed.push(s.name);
        else if (sum.changed) base.changed.push(s.name);
        if (sum.behavior) base.behaviorChanged.push(s.name);
        if (sum.uncompared) base.uncompared.push(s.name);
        for (const m of sum.mentionedRemovals) {
          if (!base.removedMembersMentioned.includes(m)) base.removedMembersMentioned.push(m);
        }
      }
      if (diff?.notes.length && !base.error) base.error = diff.notes.join(" ");
    }
    packages.push({ ...base, ...assess(base) });
  }

  const sum = (f: (p: PackageImpact) => number) => packages.reduce((n, p) => n + f(p), 0);
  const majorsCrossed = packages
    .filter((p) => p.majorsCrossed > 0)
    .map((p) => ({ name: p.name, from: p.from!, to: p.to }));

  let risk = packages.reduce<Risk>((r, p) => max(r, p.risk), "low");
  const reasons = packages
    .filter((p) => p.risk !== "low")
    .map((p) => `${p.name} (${p.risk}): ${p.reasons[0]}`);
  if (plan.conflicts.length > 0) {
    risk = "high";
    reasons.push(`${plan.conflicts.length} unresolved conflict(s) in the upgrade plan`);
  }

  return {
    packages: packages.sort(
      (a, b) => RANK[b.risk] - RANK[a.risk] || b.importSites - a.importSites,
    ),
    total: {
      packages: packages.length,
      // files can import several planned packages; count each once
      importingFiles: new Set(Array.from(imports.values()).flatMap((i) => i.files)).size,
      importSites: sum((p) => p.importSites),
      removed: sum((p) => p.removed.length),
      changed: sum((p) => p.changed.length),
      behaviorChanged: sum((p) => p.behaviorChanged.length),
    },
    risk,
    reasons,
    majorsCrossed,
    conflicts: plan.conflicts,
    notes: plan.notes,
    plan,
  };
};

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

export const printImpact = (r: ImpactReport) => {
  console.log(`# Upgrade impact: ${r.risk.toUpperCase()} risk`);
  for (const reason of r.reasons) console.log(`- ${reason}`);

  const rows = [
    ["package", "from → to", "risk", "files", "sites", "used", "removed", "changed", "behavior"],
    ...r.packages.map((p) => [
      p.name,
      `${p.from ?? "(new)"} → ${p.to}`,
      p.risk,
      String(p.importingFiles),
      String(p.importSites),
      String(p.symbolsUsed),
      String(p.removed.length),
      String(p.changed.length),
      String(p.behaviorChanged.length),
    ]),
    [
      "total",
      "",
      r.risk,
      String(r.total.importingFiles),
      String(r.total.importSites),
      "",
      String(r.total.removed),
      String(r.total.changed),
      String(r.total.behaviorChanged),
    ],
  ];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  console.log("");
  for (const row of rows) console.log(row.map((c, i) => pad(c, widths[i]!)).join("  ").trimEnd());

  for (const p of r.packages.filter((p) => p.importSites > 0)) {
    console.log(`\n## ${p.name} (${p.risk})`);
    for (const reason of p.reasons) console.log(`- ${reason}`);
  }

  if (r.majorsCrossed.length > 0) {
    console.log(
      `\nMajors crossed: ${r.majorsCrossed.map((m) => `${m.name} ${m.from} → ${m.to}`).join(", ")}`,
    );
  }
  if (r.conflicts.length > 0) {
    console.log(`\n## Conflicts (resolve before upgrading)`);
    for (const c of r.conflicts) console.log(`- ${c}`);
  }
  if (r.notes.length > 0) {
    console.log(`\n## Notes`);
    for (const n of r.notes) console.log(`- ${n}`);
  }
  console.log(`\nDetails per package: safebump api-diff <pkg> <from> <to>`);
};
