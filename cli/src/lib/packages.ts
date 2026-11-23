import { existsSync, readFileSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import semver from "semver";

import type { PackageUpgrade } from "./types";
import { run } from "./subprocess";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

type PackageJson = {
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines?: Record<string, string>;
  version?: string;
};

export const readPackageJson = (dir: string): PackageJson | undefined => {
  const file = path.join(dir, "package.json");
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf-8")) as PackageJson;
};

// walks up from `dir` to the repo root, calling `check` on each directory
const findUp = <T>(dir: string, check: (d: string) => T | undefined) => {
  let current = dir;
  while (true) {
    const found = check(current);
    if (found !== undefined) return found;
    if (existsSync(path.join(current, ".git"))) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

const LOCKFILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

export const findPackageManager = (projectRoot: string): PackageManager => {
  return (
    findUp(projectRoot, (dir) => {
      // corepack's "packageManager": "pnpm@9.1.0" is the most explicit signal
      const declared = readPackageJson(dir)?.packageManager?.split("@")[0];
      if (declared && ["npm", "pnpm", "yarn", "bun"].includes(declared)) {
        return declared as PackageManager;
      }
      return LOCKFILES.find(([file]) => existsSync(path.join(dir, file)))?.[1];
    }) ?? "npm"
  );
};

export const runScriptCommand = (pm: PackageManager, script: string) =>
  pm === "npm" ? `npm run --silent ${script}` : `${pm} run ${script}`;

// node_modules/.bin/<bin>, looking up through hoisted workspaces
export const findBin = (projectRoot: string, bin: string) =>
  findUp(projectRoot, (dir) => {
    const candidate = path.join(dir, "node_modules", ".bin", bin);
    return existsSync(candidate) ? candidate : undefined;
  });

export const installedVersion = (projectRoot: string, name: string) =>
  findUp(projectRoot, (dir) =>
    readPackageJson(path.join(dir, "node_modules", name))?.version,
  );

export const directDependencies = (projectRoot: string) => {
  const pkg = readPackageJson(projectRoot) ?? {};
  return { ...pkg.devDependencies, ...pkg.dependencies };
};

export const installedPeers = (projectRoot: string, name: string) =>
  findUp(projectRoot, (dir) => {
    const pkg = readPackageJson(path.join(dir, "node_modules", name));
    return pkg
      ? {
          peers: pkg.peerDependencies ?? {},
          optional: pkg.peerDependenciesMeta ?? {},
        }
      : undefined;
  });

export const parseSpec = (spec: string): PackageUpgrade => {
  const at = spec.lastIndexOf("@");
  if (at <= 0) throw new Error(`Expected <name>@<version>, got '${spec}'`);
  return { packageName: spec.slice(0, at), newVersion: spec.slice(at + 1) };
};

// packages bumped in package.json relative to a git ref, e.g. on a branch
// opened by an update bot
export const detectUpgrades = async (
  projectRoot: string,
  target?: string,
): Promise<PackageUpgrade[]> => {
  const existing = new Set(Object.keys(directDependencies(projectRoot)));

  const ref =
    target ??
    (
      await run("git rev-parse --abbrev-ref HEAD", { cwd: projectRoot })
    ).stdout.trim();
  const { stdout: diff } = await run(`git diff ${ref} -- package.json`, {
    cwd: projectRoot,
  });

  const upgrades: PackageUpgrade[] = [];
  for (const line of diff.split("\n")) {
    const match = line.match(/^\+[\s]*"([^"]+)": "([^"]+)",?$/);
    if (match?.[1] && match[2] && existing.has(match[1])) {
      upgrades.push({ packageName: match[1], newVersion: match[2] });
    }
  }
  return upgrades;
};

// keep the range style the project already uses ("^4.1.0" -> "^5.0.0")
const withPrefix = (existing: string, version: string) => {
  if (!semver.valid(version)) return version;
  const prefix = /^[\^~]/.exec(existing)?.[0] ?? "";
  return `${prefix}${version}`;
};

const PEER_PROBLEM =
  /ERESOLVE|peer dep|peerDependenc|Conflicting peer|Could not resolve dependency|unmet peer|incorrect peer|Issues with peer/i;

const updateManifest = async (
  dir: string,
  upgrades: PackageUpgrade[],
  addMissing: boolean,
) => {
  const pkgPath = path.join(dir, "package.json");
  const raw = await readFile(pkgPath, "utf-8");
  const indent = /^(\s+)"/m.exec(raw)?.[1] ?? "  ";
  const content = JSON.parse(raw) as PackageJson;

  // `written` is what landed in package.json, e.g. "^7.34.0"
  const applied: (PackageUpgrade & { from: string; written: string; manifest: string })[] = [];
  for (const upgrade of upgrades) {
    let found = false;
    for (const deps of [content.dependencies, content.devDependencies]) {
      const existing = deps?.[upgrade.packageName];
      if (deps && existing) {
        deps[upgrade.packageName] = withPrefix(existing, upgrade.newVersion);
        applied.push({ ...upgrade, from: existing, written: deps[upgrade.packageName]!, manifest: pkgPath });
        found = true;
      }
    }
    // a private workspace package's peer range moves with the upgrade;
    // published packages' peer ranges are an API decision, left alone
    const peers = content.peerDependencies;
    const existingPeer = peers?.[upgrade.packageName];
    if (peers && existingPeer && !addMissing && (content as { private?: boolean }).private) {
      peers[upgrade.packageName] = withPrefix(existingPeer, upgrade.newVersion);
      applied.push({ ...upgrade, from: `${existingPeer} (peer)`, written: peers[upgrade.packageName]!, manifest: pkgPath });
    }
    if (!found && addMissing) {
      // a new peer the upgrade set requires
      content.dependencies = {
        ...content.dependencies,
        [upgrade.packageName]: withPrefix("^", upgrade.newVersion),
      };
      applied.push({ ...upgrade, from: "(new)", written: withPrefix("^", upgrade.newVersion), manifest: pkgPath });
    }
  }

  if (applied.length > 0) {
    await writeFile(
      pkgPath,
      JSON.stringify(content, null, indent) + (raw.endsWith("\n") ? "\n" : ""),
    );
  }
  return applied;
};

// `extraDirs`: other workspace packages to keep on the same versions, so a
// monorepo doesn't end up with two majors of one dependency
export const applyUpgrades = async (
  projectRoot: string,
  upgrades: PackageUpgrade[],
  options: { extraDirs?: string[]; installRoot?: string } = {},
) => {
  const packageManager = findPackageManager(projectRoot);
  const applied = await updateManifest(projectRoot, upgrades, true);
  for (const dir of options.extraDirs ?? []) {
    if (path.resolve(dir) === path.resolve(projectRoot)) continue;
    applied.push(...(await updateManifest(dir, upgrades, false)));
  }

  // workspaces install from their root
  const installRoot = options.installRoot ?? projectRoot;
  const result = await run(`${packageManager} install`, { cwd: installRoot });
  const output = `${result.stdout}\n${result.stderr}`;
  const peerProblems = output
    .split("\n")
    .filter((line) => PEER_PROBLEM.test(line))
    .slice(0, 40);

  if (result.code !== 0) {
    throw new Error(
      [
        `'${packageManager} install' failed.`,
        ...(peerProblems.length > 0
          ? [
              "Peer dependency problems (run `plan` to find the packages that must move together; don't use --force or --legacy-peer-deps without asking):",
              ...peerProblems,
            ]
          : [output.trim().split("\n").slice(-40).join("\n")]),
        `package.json was modified; restore it with git checkout if you abandon this upgrade.`,
      ].join("\n"),
    );
  }
  return { packageManager, applied, peerWarnings: peerProblems };
};
