import { readFileSync } from "fs";
import path from "path";
import semver from "semver";

import { skillDir } from "./paths";
import type { PackageManager } from "./packages";
import { findPackageManager } from "./packages";
import { getManifest, getPackument } from "./registry";

// Official migration tools for an upgrade set, from two sources:
//   - a curated registry (assets/migration-tools.json), each entry sourced
//     from the vendor's docs
//   - discovery: a migration-style CLI in the new version, or a companion
//     codemod package on the registry
// Agents should run these instead of hand-editing what they automate.

type RegistryEntry = {
  id: string;
  match: string[];
  fromMajor?: number;
  toMajor?: number;
  summary: string;
  steps: string[];
  oneMajorAtATime?: boolean;
  replacesUpgrade?: boolean;
  guide?: string;
  changelog?: string;
  source: string;
};

export type MigrationTool = {
  id: string;
  packages: string[];
  summary: string;
  steps: string[];
  oneMajorAtATime: boolean;
  // true when the tool sets versions itself, so `safebump upgrade` for these
  // packages should be skipped
  replacesUpgrade: boolean;
  guide?: string;
  changelog?: string;
  source: string;
  origin: "registry" | "discovered";
};


const loadRegistry = (): RegistryEntry[] =>
  (
    JSON.parse(
      readFileSync(path.join(skillDir(), "assets", "migration-tools.json"), "utf-8"),
    ) as { tools: RegistryEntry[] }
  ).tools;

const matches = (pattern: string, name: string) =>
  pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;

const RUNNER: Record<PackageManager, string> = {
  npm: "npx",
  pnpm: "pnpm dlx",
  yarn: "yarn dlx",
  bun: "bunx",
};

const fill = (text: string, vars: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => vars[key] ?? all);

const MIGRATION_BIN = /migrat|upgrade|codemod/i;

export const findMigrationTools = async (
  projectRoot: string,
  upgrades: { name: string; from?: string; to: string }[],
): Promise<MigrationTool[]> => {
  const pm = findPackageManager(projectRoot);
  const majors = upgrades.filter(
    (u) => !u.from || !semver.valid(u.from) || semver.major(u.from) !== semver.major(u.to),
  );
  const tools = new Map<string, MigrationTool>();

  for (const entry of loadRegistry()) {
    const hits = majors.filter((u) => {
      if (!entry.match.some((p) => matches(p, u.name))) return false;
      const from = u.from && semver.valid(u.from) ? semver.major(u.from) : undefined;
      const to = semver.major(u.to);
      return (
        (entry.fromMajor === undefined || from === undefined || from === entry.fromMajor) &&
        (entry.toMajor === undefined || to === entry.toMajor)
      );
    });
    if (hits.length === 0) continue;
    // the family's main package decides the version, e.g. expo for expo-*
    const main =
      hits.find((h) => entry.match.includes(h.name)) ?? hits[0]!;
    const vars = {
      to: main.to,
      toMajor: String(semver.major(main.to)),
      pm,
      pmx: RUNNER[pm],
    };
    tools.set(entry.id, {
      id: entry.id,
      packages: hits.map((h) => h.name),
      summary: entry.summary,
      steps: entry.steps.map((s) => fill(s, vars)),
      oneMajorAtATime: entry.oneMajorAtATime ?? false,
      replacesUpgrade: entry.replacesUpgrade ?? false,
      guide: entry.guide && fill(entry.guide, vars),
      changelog: entry.changelog && fill(entry.changelog, vars),
      source: entry.source,
      origin: "registry",
    });
  }

  const covered = new Set(Array.from(tools.values()).flatMap((t) => t.packages));
  await Promise.all(
    majors
      .filter((u) => !covered.has(u.name) && !u.name.startsWith("@types/"))
      .map(async (u) => {
        const found: string[] = [];
        const manifest = (await getManifest(projectRoot, u.name, u.to).catch(
          () => undefined,
        )) as { bin?: string | Record<string, string> } | undefined;
        const bins =
          typeof manifest?.bin === "string"
            ? [u.name.split("/").pop()!]
            : Object.keys(manifest?.bin ?? {});
        for (const bin of bins.filter((b) => MIGRATION_BIN.test(b))) {
          found.push(`${RUNNER[pm]} -p ${u.name}@${u.to} ${bin} --help`);
        }
        // companion codemod packages, e.g. @mui/codemod, @next/codemod
        const scope = u.name.startsWith("@") ? u.name.split("/")[0] : undefined;
        const candidates = [
          ...(scope ? [`${scope}/codemod`, `${scope}/codemods`] : []),
          `${u.name}-codemod`,
          `${u.name}-codemods`,
          ...(!scope ? [`@${u.name}/codemod`] : []),
        ];
        for (const c of candidates) {
          const p = await getPackument(projectRoot, c).catch(() => undefined);
          if (p) found.push(`${RUNNER[pm]} ${c}@latest --help`);
        }
        if (found.length > 0) {
          tools.set(`discovered:${u.name}`, {
            id: `discovered:${u.name}`,
            packages: [u.name],
            summary: `${u.name} publishes migration tooling. Check its docs for the recipe for ${u.from ?? "?"} → ${u.to} before editing by hand.`,
            steps: found,
            oneMajorAtATime: false,
            replacesUpgrade: false,
            source: `https://www.npmjs.com/package/${u.name}`,
            origin: "discovered",
          });
        }
      }),
  );

  return Array.from(tools.values());
};

export const printMigrationTools = (tools: MigrationTool[]) => {
  if (tools.length === 0) return;
  console.log(`\n## Official migration tools (use these instead of hand edits)`);
  for (const t of tools) {
    console.log(`\n### ${t.id}: ${t.packages.join(", ")}${t.origin === "discovered" ? " (discovered)" : ""}`);
    console.log(t.summary);
    t.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    if (t.oneMajorAtATime) console.log(`  One major version at a time.`);
    if (t.replacesUpgrade) {
      console.log(`  Replaces \`safebump upgrade\` for these packages: the tool sets their versions.`);
    }
    if (t.guide) console.log(`  guide: ${t.guide}`);
    if (t.changelog) console.log(`  changelog: ${t.changelog}`);
  }
};
