import semver from "semver";

import type { PackageUpgrade } from "./types";
import {
  directDependencies,
  installedPeers,
  installedVersion,
} from "./packages";
import type { Packument } from "./registry";
import { listWorkspaces } from "./workspaces";
import {
  getManifest,
  getPackument,
  resolveVersion,
  stableVersions,
} from "./registry";

// Works out every package that has to move with the requested upgrades:
// peers the new versions require, installed packages whose peer ranges
// exclude the new versions, siblings released in lockstep, and @types.

type Constraint = { range: string; by: string };

export type PlannedUpgrade = {
  name: string;
  from?: string;
  to: string;
  reasons: string[];
};

export type UpgradePlan = {
  upgrades: PlannedUpgrade[];
  conflicts: string[];
  notes: string[];
};

const satisfies = (version: string, range: string) =>
  semver.satisfies(version, range, { includePrerelease: true });

const typesPackageName = (name: string) =>
  `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;

const scopeOf = (name: string) =>
  name.startsWith("@") ? name.split("/")[0] : undefined;

export const planUpgrades = async (
  projectRoot: string,
  targets: { name: string; spec?: string }[],
  // other workspace packages whose dependencies also count as direct
  extraDirs: string[] = [],
  // versions to treat as already installed, e.g. upgrades an earlier branch
  // will have made (used by fleet to sequence groups)
  assume: Record<string, string> = {},
): Promise<UpgradePlan> => {
  const plan = new Map<string, PlannedUpgrade>();
  const constraints = new Map<string, Constraint[]>();
  // keyed by package so a conflict refined over several rounds prints once
  const conflicts = new Map<string, string>();
  const notes: string[] = [];
  const direct = Object.assign(
    {},
    ...extraDirs.map(directDependencies),
    directDependencies(projectRoot),
  ) as Record<string, string>;

  // the project's own workspace packages: their peer ranges get edited
  // (upgrade --all-workspaces), they're never conflicts
  const localPackages = new Set(
    listWorkspaces(projectRoot)
      .map((w) => w.name)
      .filter((n): n is string => !!n),
  );

  const current = (name: string) =>
    plan.get(name)?.to ?? assume[name] ?? installedVersion(projectRoot, name);

  const peersOf = async (dep: string) => {
    const assumed = assume[dep];
    if (!assumed) return installedPeers(projectRoot, dep);
    const p = await getPackument(projectRoot, dep);
    return { peers: p.versions[assumed]?.peerDependencies ?? {}, optional: {} };
  };

  // highest stable version meeting every constraint collected for `name`
  const choose = (p: Packument, name: string) => {
    const ranges = constraints.get(name) ?? [];
    return semver.rsort(
      stableVersions(p).filter((v) => ranges.every((c) => satisfies(v, c.range))),
    )[0];
  };

  const set = (name: string, to: string, reason: string) => {
    const existing = plan.get(name);
    if (existing) {
      const changed = existing.to !== to || !existing.reasons.includes(reason);
      existing.to = to;
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      return changed;
    }
    plan.set(name, {
      name,
      from: installedVersion(projectRoot, name),
      to,
      reasons: [reason],
    });
    return true;
  };

  for (const target of targets) {
    const p = await getPackument(projectRoot, target.name);
    const to = resolveVersion(p, target.spec);
    if (!to) {
      conflicts.set(target.name, `${target.name}: no version matches '${target.spec}'`);
      continue;
    }
    constraints.set(target.name, [{ range: to, by: "requested" }]);
    set(target.name, to, "requested");
  }

  // lockstep siblings: same scope as a requested package (or the scope named
  // after an unscoped one, e.g. tamagui and @tamagui/*), on the same major,
  // with a release at exactly the new version (@angular/*, @tamagui/*)
  for (const target of targets) {
    const planned = plan.get(target.name);
    const fromVersion = installedVersion(projectRoot, target.name);
    if (!planned || !fromVersion || !semver.valid(fromVersion)) continue;
    const scope = scopeOf(target.name) ?? `@${target.name}`;
    const familyOf = (dep: string) =>
      dep.startsWith(`${scope}/`) || (scopeOf(target.name) === undefined && dep === target.name);
    for (const dep of Object.keys(direct)) {
      if (dep === target.name || plan.has(dep) || !familyOf(dep)) continue;
      const depVersion = installedVersion(projectRoot, dep);
      if (!depVersion || !semver.valid(depVersion)) continue;
      if (semver.major(depVersion) !== semver.major(fromVersion)) continue;
      const p = await getPackument(projectRoot, dep).catch(() => undefined);
      if (p?.versions[planned.to]) {
        constraints.set(dep, [
          { range: planned.to, by: `lockstep with ${target.name}` },
        ]);
        set(
          dep,
          planned.to,
          `released in lockstep with ${target.name} (${depVersion} alongside ${fromVersion})`,
        );
      }
    }
  }

  // propagate peer requirements until nothing changes
  for (let round = 0, changed = true; changed && round < 20; round++) {
    changed = false;

    // forward: peers required by the planned versions
    for (const member of Array.from(plan.values())) {
      const p = await getPackument(projectRoot, member.name);
      const meta = p.versions[member.to];
      for (const [peer, range] of Object.entries(meta?.peerDependencies ?? {})) {
        const have = current(peer);
        const optional = meta?.peerDependenciesMeta?.[peer]?.optional;
        if (!have && optional) continue;
        if (have && satisfies(have, range)) continue;

        const by = `${member.name}@${member.to} peers on ${peer} ${range}`;
        const list = constraints.get(peer) ?? [];
        if (!list.some((c) => c.by === by)) list.push({ range, by });
        constraints.set(peer, list);

        const peerPackument = await getPackument(projectRoot, peer);
        const to = choose(peerPackument, peer);
        if (!to) {
          conflicts.set(
            peer,
            `${peer}: no version satisfies all of ${list.map((c) => `${c.range} (${c.by})`).join(", ")}`,
          );
          continue;
        }
        if (set(peer, to, have ? by : `${by}, not installed`)) changed = true;
      }
    }

    // reverse: installed packages whose peer ranges exclude a planned version
    for (const dep of Object.keys(direct)) {
      if (plan.has(dep)) continue;
      const installed = await peersOf(dep);
      if (!installed) continue;
      const broken = Object.entries(installed.peers).filter(([peer, range]) => {
        const planned = plan.get(peer);
        return planned && !satisfies(planned.to, range);
      });
      if (broken.length === 0) continue;
      if (localPackages.has(dep)) {
        const note = `${dep} is a workspace package whose peerDependencies (${broken.map(([peer, range]) => `${peer} ${range}`).join(", ")}) exclude the planned versions; \`upgrade --all-workspaces\` updates them.`;
        if (!notes.includes(note)) notes.push(note);
        continue;
      }

      const p = await getPackument(projectRoot, dep).catch(() => undefined);
      const from = assume[dep] ?? installedVersion(projectRoot, dep) ?? "0.0.0";
      const candidate = p
        ? semver
            .rsort(stableVersions(p).filter((v) => semver.gte(v, from)))
            .find((v) =>
              Object.entries(p.versions[v]?.peerDependencies ?? {}).every(
                ([peer, range]) => {
                  const planned = plan.get(peer);
                  return !planned || satisfies(planned.to, range);
                },
              ),
            )
        : undefined;

      const why = broken
        .map(([peer, range]) => `${dep}@${from} peers on ${peer} ${range}`)
        .join("; ");
      if (!candidate) {
        conflicts.set(
          dep,
          `${dep}: ${why}, and no release of ${dep} accepts the planned versions. It may need replacing or removing.`,
        );
        continue;
      }
      constraints.set(dep, [{ range: candidate, by: why }]);
      if (set(dep, candidate, why)) changed = true;
    }
  }

  // @types packages for planned upgrades
  for (const member of Array.from(plan.values())) {
    if (member.name.startsWith("@types/")) continue;
    const typesName = typesPackageName(member.name);
    if (!(typesName in direct) || plan.has(typesName)) continue;
    const manifest = await getManifest(projectRoot, member.name, member.to);
    if (manifest?.types || manifest?.typings) {
      notes.push(
        `${member.name}@${member.to} ships its own types; ${typesName} can probably be removed.`,
      );
      continue;
    }
    const p = await getPackument(projectRoot, typesName).catch(() => undefined);
    const major = semver.major(member.to);
    const to = p && semver.maxSatisfying(stableVersions(p), `${major}.x`);
    const have = assume[typesName] ?? installedVersion(projectRoot, typesName);
    if (to && (!have || semver.major(have) !== major)) {
      set(typesName, to, `types for ${member.name}@${member.to}`);
    }
  }

  for (const member of plan.values()) {
    if (member.from && semver.valid(member.from)) {
      const majors = semver.major(member.to) - semver.major(member.from);
      if (majors > 1) {
        notes.push(
          `${member.name} crosses ${majors} major versions (${member.from} → ${member.to}). Check whether the migration guide requires going one major at a time.`,
        );
      }
    }
    const p = await getPackument(projectRoot, member.name);
    const engines = p.versions[member.to]?.engines?.node;
    if (engines && !satisfies(process.version, engines)) {
      notes.push(
        `${member.name}@${member.to} requires node ${engines}; this machine runs ${process.version}.`,
      );
    }
    const deprecated = p.versions[member.to]?.deprecated;
    if (deprecated) {
      notes.push(`${member.name}@${member.to} is deprecated: ${deprecated}`);
    }
  }

  return {
    upgrades: Array.from(plan.values()),
    conflicts: Array.from(conflicts.values()),
    notes,
  };
};

export const toSpecs = (plan: UpgradePlan): PackageUpgrade[] =>
  plan.upgrades.map((u) => ({ packageName: u.name, newVersion: u.to }));
