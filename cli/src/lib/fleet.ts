import path from "path";
import semver from "semver";

import type { MigrationTool } from "./migration-tools";
import type { PlannedUpgrade } from "./plan";
import { planUpgrades } from "./plan";
import { getManifest, getPackument } from "./registry";
import { installedVersion, readPackageJson } from "./packages";
import { findWorkspaceRoot, listWorkspaces } from "./workspaces";

// Splits every pending upgrade into independent groups that can each be done
// on its own branch: all minor/patch bumps together, and each major with
// the packages `plan` says must move with it. Groups are sequenced (see
// planFleet) so no two branches touch the same dependency.

export type FleetGroup = {
  id: string;
  kind: "minor-patch" | "major";
  branch: string;
  // branches that must merge first
  after: string[];
  upgrades: PlannedUpgrade[];
  conflicts: string[];
  notes: string[];
  // official migration tools for this group, filled in by the caller
  tools?: MigrationTool[];
  // filled in by the caller when an impact preview is available
  risk?: { level: "low" | "medium" | "high"; reasons: string[] };
};

export type FleetPlan = {
  groups: FleetGroup[];
  skipped: string[];
  // apply commands need --all-workspaces in a monorepo
  workspaces: boolean;
};

// "github.com/expo/expo" from any of the repository field's forms
const repoKey = (repo: string | { url?: string } | undefined) => {
  const url = typeof repo === "string" ? repo : repo?.url;
  const m = url && /github\.com[/:]([^/]+\/[^/.#]+)/i.exec(url);
  if (m?.[1]) return `github.com/${m[1].toLowerCase()}`;
  const short = url && /^(?:github:)?([\w-]+\/[\w.-]+)$/.exec(url);
  return short?.[1] ? `github.com/${short[1].toLowerCase()}` : undefined;
};

const safeMinVersion = (range: string) => {
  try {
    return semver.minVersion(range)?.version;
  } catch {
    return undefined;
  }
};

const slug = (names: string[]) =>
  names
    .map((n) => n.replace(/^@/, "").replace(/\//g, "-"))
    .join("+")
    .slice(0, 60);

// every dependency of every workspace package (or just the project when it
// isn't a workspace root), with the newest version any of them can take
export const listAllUpgrades = async (projectRoot: string) => {
  const isWorkspaceRoot = findWorkspaceRoot(projectRoot) === projectRoot;
  const dirs = isWorkspaceRoot
    ? listWorkspaces(projectRoot).map((w) => w.dir)
    : [projectRoot];

  // every registry dependency of every manifest, by name
  const aliases = new Set<string>();
  const uses = new Map<string, { dir: string; where: string }[]>();
  for (const dir of dirs) {
    const pkg = readPackageJson(dir) as
      | { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
      | undefined;
    const where = path.relative(projectRoot, dir) || ".";
    const deps = { ...pkg?.optionalDependencies, ...pkg?.devDependencies, ...pkg?.dependencies };
    for (const [name, range] of Object.entries(deps)) {
      // aliases (npm:pkg@1.2.3) are upgraded by editing the alias;
      // workspace:, file:, link: and git specs aren't registry packages
      if (range.startsWith("npm:")) {
        aliases.add(`${name} → ${range}`);
        continue;
      }
      if (!safeMinVersion(range)) continue;
      uses.set(name, [...(uses.get(name) ?? []), { dir, where }]);
    }
  }

  const byName = new Map<
    string,
    { name: string; from?: string; to: string; major: boolean; workspaces: string[] }
  >();
  await mapLimit(Array.from(uses.entries()), 16, async ([name, sites]) => {
    const p = await getPackument(projectRoot, name).catch(() => undefined);
    const latest = p?.["dist-tags"].latest;
    if (!latest || !semver.valid(latest)) return;
    const from = sites
      .map((s) => installedVersion(s.dir, name))
      .filter((v): v is string => !!v && !!semver.valid(v))
      .sort(semver.compare)[0];
    if (from && !semver.gt(latest, from)) return;
    byName.set(name, {
      name,
      from,
      to: latest,
      major: !from || semver.major(latest) !== semver.major(from),
      workspaces: sites.map((s) => s.where),
    });
  });

  return {
    upgrades: Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name)),
    isWorkspaceRoot,
    aliases: Array.from(aliases),
  };
};

// run `fn` over items with at most `limit` in flight (registry politeness)
const mapLimit = async <T>(items: T[], limit: number, fn: (item: T) => Promise<void>) => {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
};

export const planFleet = async (projectRoot: string): Promise<FleetPlan> => {
  const { upgrades: all, isWorkspaceRoot, aliases } = await listAllUpgrades(projectRoot);
  const skipped: string[] = aliases.map(
    (a) => `${a}: aliased dependency; upgrade it by editing the alias in package.json`,
  );
  // in a monorepo every workspace's dependencies count when planning
  const extraDirs = isWorkspaceRoot
    ? listWorkspaces(projectRoot).map((w) => w.dir)
    : [];

  // @types follow their package's major inside `plan`; a major @types bump
  // nothing claims becomes its own group (e.g. @types/node, which should
  // track the Node version the project runs, not the latest)
  const majors = all.filter((u) => u.major && !u.name.startsWith("@types/"));
  const minors = all.filter((u) => !u.major);

  // Plan each major alone, then build groups smallest first. Each later
  // group is planned as if earlier groups had landed, so a package that only
  // needed a companion bump because of an older peer (react 19 needing
  // react-query 5) becomes a smaller follow-up branch instead of one giant
  // merged one.
  // Packages released together (Expo SDK, Tamagui, Babel) rarely declare
  // peers on each other, so group majors by source repository, falling back
  // to npm scope, and plan each family as one unit.
  const families = new Map<string, (typeof majors)[number][]>();
  const familyRepo = new Map<string, string | undefined>();
  await Promise.all(
    majors.map(async (m) => {
      const manifest = await getManifest(projectRoot, m.name, m.to).catch(() => undefined);
      const repo = repoKey(manifest?.repository);
      const key = repo ?? (m.name.startsWith("@") ? m.name.split("/")[0]! : m.name);
      families.set(key, [...(families.get(key) ?? []), m]);
      familyRepo.set(m.name, repo);
    }),
  );

  const standalone: {
    targets: (typeof majors)[number][];
    names: Set<string>;
    size: number;
  }[] = [];
  for (const members of families.values()) {
    try {
      const p = await planUpgrades(
        projectRoot,
        members.map((m) => ({ name: m.name, spec: m.to })),
        extraDirs,
      );
      standalone.push({
        targets: members,
        names: new Set(p.upgrades.map((u) => u.name)),
        size: p.upgrades.length,
      });
    } catch (e) {
      skipped.push(
        `${members.map((m) => m.name).join(", ")}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  standalone.sort((a, b) => a.size - b.size);

  const groups: FleetGroup[] = [];
  const claimed = new Map<string, FleetGroup>();
  const assume: Record<string, string> = {};
  for (const { targets: family, names } of standalone) {
    const targets = family.filter((t) => !claimed.has(t.name));
    if (targets.length === 0) continue;
    // name the group after the family's main package: the one named like
    // the repo ("expo" in expo/expo), else the shortest name
    const repoName = familyRepo.get(targets[0]!.name)?.split("/").pop();
    const target =
      targets.find((t) => t.name === repoName) ??
      targets.slice().sort((a, b) => a.name.length - b.name.length)[0]!;
    const label =
      targets.length > 1 ? `${target.name} (+${targets.length - 1} released with it)` : target.name;
    const p = await planUpgrades(
      projectRoot,
      targets.map((t) => ({ name: t.name, spec: t.to })),
      extraDirs,
      assume,
    );
    const clash = p.upgrades.find(
      (u) => claimed.has(u.name) && assume[u.name] !== u.to,
    );
    if (clash) {
      // can't be sequenced: fold it into the group it clashes with
      const owner = claimed.get(clash.name)!;
      const merged = await planUpgrades(
        projectRoot,
        [
          ...owner.upgrades.map((u) => ({ name: u.name, spec: u.to })),
          ...targets.map((t) => ({ name: t.name, spec: t.to })),
        ],
        extraDirs,
      );
      owner.id = `${owner.id}, ${label}`;
      owner.upgrades = merged.upgrades;
      owner.conflicts = merged.conflicts;
      owner.notes = merged.notes;
      for (const u of merged.upgrades) {
        claimed.set(u.name, owner);
        assume[u.name] = u.to;
      }
      continue;
    }
    // earlier groups this one relies on: their packages were in its
    // standalone plan but dropped out once assumed
    const after = Array.from(
      new Set(
        Array.from(names)
          .filter((n) => claimed.has(n))
          .map((n) => claimed.get(n)!.branch),
      ),
    );
    const group: FleetGroup = {
      id: label,
      kind: "major",
      branch: `safebump/${slug([target.name])}`,
      after,
      upgrades: p.upgrades,
      conflicts: p.conflicts,
      notes: p.notes,
    };
    groups.push(group);
    for (const u of p.upgrades) {
      claimed.set(u.name, group);
      assume[u.name] = u.to;
    }
  }

  const remainingMinors = minors.filter((u) => !claimed.has(u.name));
  for (const t of all.filter(
    (u) => u.major && u.name.startsWith("@types/") && !claimed.has(u.name),
  )) {
    groups.push({
      id: t.name,
      kind: "major",
      branch: `safebump/${slug([t.name])}`,
      after: [],
      upgrades: [{ name: t.name, from: t.from, to: t.to, reasons: ["types package with no matching runtime upgrade"] }],
      conflicts: [],
      notes:
        t.name === "@types/node"
          ? [`@types/node should match the Node major the project runs on (this machine: ${process.version}); upgrade it only with the runtime.`]
          : [],
    });
  }
  const batch = remainingMinors;
  if (batch.length > 0) {
    groups.unshift({
      id: "minor and patch updates",
      kind: "minor-patch",
      branch: "safebump/minor-patch",
      after: [],
      upgrades: batch.map((u) => ({
        name: u.name,
        from: u.from,
        to: u.to,
        reasons: [u.workspaces.length > 1 || u.workspaces[0] !== "." ? `non-major update (${u.workspaces.join(", ")})` : "non-major update"],
      })),
      conflicts: [],
      notes: [],
    });
  }

  return { groups, skipped, workspaces: isWorkspaceRoot };
};

const RISK_ORDER = { low: 0, medium: 1, high: 2 } as const;

// safest first, but never before a group it depends on
export const sortByRisk = (groups: FleetGroup[]) => {
  const byRisk = groups.slice().sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "minor-patch" ? -1 : 1;
    const ra = a.risk ? RISK_ORDER[a.risk.level] : 1;
    const rb = b.risk ? RISK_ORDER[b.risk.level] : 1;
    return ra - rb || a.upgrades.length - b.upgrades.length;
  });
  const ordered: FleetGroup[] = [];
  const placed = new Set<string>();
  const place = (g: FleetGroup) => {
    if (placed.has(g.branch)) return;
    placed.add(g.branch);
    for (const dep of g.after) {
      const d = groups.find((x) => x.branch === dep);
      if (d) place(d);
    }
    ordered.push(g);
  };
  byRisk.forEach(place);
  return ordered;
};

export const printFleet = (fleet: FleetPlan) => {
  const groups = sortByRisk(fleet.groups);
  console.log(
    `${groups.length} independent upgrade group(s), safest first. Each goes on its own branch.`,
  );
  groups.forEach((g, i) => {
    const risk = g.risk ? ` · risk: ${g.risk.level}` : "";
    console.log(`\n## ${i + 1}. ${g.id} (${g.kind}${risk})`);
    console.log(`branch: ${g.branch}${g.after.length ? ` (after ${g.after.join(", ")})` : ""}`);
    if (g.risk?.reasons.length) console.log(`why: ${g.risk.reasons.join("; ")}`);
    for (const u of g.upgrades) {
      console.log(`- ${u.name} ${u.from ?? "(new)"} → ${u.to}`);
    }
    for (const c of g.conflicts) console.log(`  conflict: ${c}`);
    for (const n of g.notes) console.log(`  note: ${n}`);
    for (const t of g.tools ?? []) {
      console.log(`tool (${t.id}): ${t.steps.slice(0, 3).join(" → ")}${t.oneMajorAtATime ? " · one major at a time" : ""}`);
      if (t.guide) console.log(`  guide: ${t.guide}`);
    }
    if (g.conflicts.length === 0) {
      const byTool = new Set(
        (g.tools ?? []).filter((t) => t.replacesUpgrade).flatMap((t) => t.packages),
      );
      const rest = g.upgrades.filter((u) => !byTool.has(u.name));
      if (byTool.size > 0) console.log(`apply: run the tool above for ${byTool.size} package(s)`);
      if (rest.length > 0) {
        console.log(
          `apply${byTool.size > 0 ? " (rest)" : ""}: safebump upgrade ${rest.map((u) => `${u.name}@${u.to}`).join(" ")}${fleet.workspaces ? " --all-workspaces" : ""}`,
        );
      }
    }
  });
  if (fleet.skipped.length > 0) {
    console.log(`\n## Skipped`);
    for (const s of fleet.skipped) console.log(`- ${s}`);
  }
};
