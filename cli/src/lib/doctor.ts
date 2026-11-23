import { existsSync, readdirSync, readFileSync, realpathSync } from "fs";
import path from "path";
import semver from "semver";

import { resolveChecker } from "./checker";
import type { PackageManager } from "./packages";
import { findPackageManager, readPackageJson } from "./packages";
import { getPackument, resolveVersion } from "./registry";
import { run } from "./subprocess";
import { tsconfigReferences } from "./typescript/index";
import { findWorkspaceRoot, listWorkspaces } from "./workspaces";

// Preflight before an upgrade: an agent run on a stale install, a broken
// checker or a dirty tree spends its effort on errors the upgrade didn't
// cause.

export type CheckStatus = "ok" | "warn" | "fail";

export type Check = {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
};

export type DoctorReport = {
  // no check failed
  ok: boolean;
  checks: Check[];
};

const MAX_LISTED = 15;

const listed = (items: string[]) =>
  items.length > MAX_LISTED
    ? `${items.slice(0, MAX_LISTED).join(", ")} (+${items.length - MAX_LISTED} more)`
    : items.join(", ");

const LOCKFILE_NAMES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

// "@s/p@^1" -> { name: "@s/p", spec: "^1" }; a bare name has no spec
export const parseTarget = (target: string) => {
  const at = target.lastIndexOf("@");
  return at > 0
    ? { name: target.slice(0, at), spec: target.slice(at + 1) || undefined }
    : { name: target, spec: undefined };
};

// the directory installs run from: the workspace root when there is one
const installRoot = (projectRoot: string) =>
  findWorkspaceRoot(projectRoot) ?? projectRoot;

// manifests whose dependencies must be installed: every workspace when run
// at a workspace root, otherwise just the project
const manifestDirs = (projectRoot: string) => {
  const root = findWorkspaceRoot(projectRoot);
  if (root && path.resolve(root) === path.resolve(projectRoot)) {
    return listWorkspaces(projectRoot).map((w) => w.dir);
  }
  return [projectRoot];
};

const installCommand = (pm: PackageManager, hasLockfile: boolean) =>
  pm === "npm"
    ? hasLockfile
      ? "npm ci (or npm install to also update the lockfile)"
      : "npm install"
    : `${pm} install`;

// --- install matches manifests ---

type Declared = { name: string; range: string; dir: string };

const declaredDependencies = (dir: string): Declared[] => {
  const pkg = readPackageJson(dir) ?? {};
  // optionalDependencies may legitimately be absent (platform-specific)
  return Object.entries({ ...pkg.devDependencies, ...pkg.dependencies }).map(
    ([name, range]) => ({ name, range, dir }),
  );
};

// ranges that don't name a registry version can't be compared
const NON_REGISTRY =
  /^(workspace:|file:|link:|portal:|patch:|catalog:|git\+|git:|github:|https?:|[\w.-]+\/[\w.-]+(#.*)?$)/;

// node_modules/<name>/package.json walking up from `dir`, as Node resolves it
const resolveInstalled = (dir: string, name: string) => {
  let current = dir;
  while (true) {
    const pkgDir = path.join(current, "node_modules", name);
    const manifest = readPackageJson(pkgDir) as
      | { name?: string; version?: string }
      | undefined;
    if (manifest) return { ...manifest, dir: pkgDir };
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

const checkDeclared = (d: Declared) => {
  if (NON_REGISTRY.test(d.range)) return undefined;
  // "npm:real-name@^2" installs real-name under the alias
  const alias = /^npm:((?:@[^/]+\/)?[^@]+)(?:@(.+))?$/.exec(d.range);
  const expectedName = alias?.[1] ?? d.name;
  const range = alias ? (alias[2] ?? "*") : d.range;
  const installed = resolveInstalled(d.dir, d.name);
  if (!installed) return `${d.name} (missing)`;
  if (alias && installed.name !== expectedName) {
    return `${d.name} (is ${installed.name}, expected ${expectedName})`;
  }
  // dist-tags and other non-semver specs only need to be present
  if (!semver.validRange(range) || !installed.version) return undefined;
  if (!semver.satisfies(installed.version, range, { includePrerelease: true })) {
    return `${d.name} (${installed.version} installed, ${range} declared)`;
  }
  return undefined;
};

const checkInstall = (projectRoot: string): Check => {
  const root = installRoot(projectRoot);
  const pm = findPackageManager(projectRoot);
  if (existsSync(path.join(root, ".pnp.cjs"))) {
    return {
      name: "install",
      status: "warn",
      detail: "Yarn Plug'n'Play install: node_modules isn't used, so it wasn't checked",
    };
  }
  const problems: string[] = [];
  const dirs = manifestDirs(projectRoot);
  for (const dir of dirs) {
    const where = path.relative(root, dir) || ".";
    for (const d of declaredDependencies(dir)) {
      const problem = checkDeclared(d);
      if (problem) problems.push(dirs.length > 1 ? `${where}: ${problem}` : problem);
    }
  }
  if (problems.length === 0) {
    return {
      name: "install",
      status: "ok",
      detail: `direct dependencies of ${dirs.length} package.json file(s) installed and in range`,
    };
  }
  const hasLockfile = LOCKFILE_NAMES.some((f) => existsSync(path.join(root, f)));
  return {
    name: "install",
    status: "fail",
    detail: `${problems.length} declared dependenc${problems.length === 1 ? "y" : "ies"} not installed or out of range: ${listed(problems)}`,
    fix: `run ${installCommand(pm, hasLockfile)} in ${root}`,
  };
};

// --- lockfile ---

// npm's lockfile records each package.json's declared ranges; a mismatch
// means `npm ci` will refuse to install
const staleNpmLock = (root: string, lockFile: string) => {
  const lock = JSON.parse(readFileSync(lockFile, "utf-8")) as {
    packages?: Record<string, Record<string, Record<string, string> | undefined>>;
  };
  if (!lock.packages) return []; // lockfileVersion 1 has no manifest copy
  const stale: string[] = [];
  for (const dir of [root, ...listWorkspaces(root).map((w) => w.dir)]) {
    const rel = path.relative(root, dir);
    const entry = lock.packages[rel];
    const pkg = readPackageJson(dir);
    if (!entry || !pkg) continue;
    for (const field of ["dependencies", "devDependencies"] as const) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        if (entry[field]?.[name] !== range) {
          stale.push(`${rel || "."}: ${name} ${range} (lockfile: ${entry[field]?.[name] ?? "absent"})`);
        }
      }
    }
  }
  return Array.from(new Set(stale));
};

// pnpm-lock.yaml lists each importer's specifiers:
//   importers:
//     apps/web:
//       dependencies:
//         react:
//           specifier: ^18.2.0
const stalePnpmLock = (root: string, lockFile: string) => {
  const recorded = new Map<string, string>();
  let importer: string | undefined;
  let dep: string | undefined;
  let inImporters = false;
  for (const line of readFileSync(lockFile, "utf-8").split("\n")) {
    if (/^\S/.test(line)) {
      inImporters = line.startsWith("importers:");
      continue;
    }
    if (!inImporters) continue;
    const m = /^( *)(.+?):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, indent, rawKey, value] = m;
    const key = rawKey!.replace(/^['"]|['"]$/g, "");
    if (indent!.length === 2) importer = key;
    else if (indent!.length === 6) dep = key;
    else if (indent!.length === 8 && key === "specifier" && importer && dep) {
      recorded.set(`${importer}\0${dep}`, value!.replace(/^['"]|['"]$/g, ""));
    }
  }
  if (recorded.size === 0) return [];
  const stale: string[] = [];
  for (const dir of [root, ...listWorkspaces(root).map((w) => w.dir)]) {
    const rel = path.relative(root, dir) || ".";
    const pkg = readPackageJson(dir);
    for (const [name, range] of Object.entries({ ...pkg?.devDependencies, ...pkg?.dependencies })) {
      const locked = recorded.get(`${rel}\0${name}`);
      if (locked !== range) stale.push(`${rel}: ${name} ${range} (lockfile: ${locked ?? "absent"})`);
    }
  }
  return Array.from(new Set(stale));
};

const checkLockfile = async (projectRoot: string): Promise<Check> => {
  const root = installRoot(projectRoot);
  const pm = findPackageManager(projectRoot);
  const lockfile = LOCKFILE_NAMES.find((f) => existsSync(path.join(root, f)));
  if (!lockfile) {
    return {
      name: "lockfile",
      status: "warn",
      detail: `no lockfile in ${root}: installs aren't reproducible and the upgrade diff won't show transitive changes`,
      fix: `run ${pm} install and commit the lockfile`,
    };
  }
  const lockPath = path.join(root, lockfile);
  let stale: string[] = [];
  try {
    if (lockfile === "package-lock.json" || lockfile === "npm-shrinkwrap.json") {
      stale = staleNpmLock(root, lockPath);
    } else if (lockfile === "pnpm-lock.yaml") {
      stale = stalePnpmLock(root, lockPath);
    }
  } catch (e) {
    return {
      name: "lockfile",
      status: "warn",
      detail: `${lockfile} could not be parsed: ${(e as Error).message}`,
    };
  }
  if (stale.length > 0) {
    return {
      name: "lockfile",
      status: "fail",
      detail: `${lockfile} doesn't match package.json for ${stale.length} dependenc${stale.length === 1 ? "y" : "ies"}: ${listed(stale)}`,
      fix: `run ${pm} install in ${root} and commit the lockfile (or revert the package.json edits)`,
    };
  }

  // npm also knows about invalid and extraneous packages in the tree
  if (pm === "npm") {
    const { stdout } = await run("npm ls --depth=0 --json", { cwd: root });
    let problems: string[] = [];
    try {
      problems = (JSON.parse(stdout) as { problems?: string[] }).problems ?? [];
    } catch {
      // unparseable output: the manifest checks above already ran
    }
    // "missing" is reported by the install check with more context
    problems = problems
      .filter((p) => !/^missing:/.test(p))
      .map((p) => p.split(`${root}${path.sep}`).join(""));
    if (problems.length > 0) {
      return {
        name: "lockfile",
        status: "warn",
        detail: `npm ls reports ${problems.length} problem(s): ${listed(problems)}`,
        fix: `run npm ci in ${root}`,
      };
    }
  }
  return {
    name: "lockfile",
    status: "ok",
    detail: `${lockfile} matches package.json${pm === "yarn" || pm === "bun" ? " (presence only for " + pm + ")" : ""}`,
  };
};

// --- type checker ---

const checkChecker = async (projectRoot: string, override?: string): Promise<Check> => {
  let checker;
  try {
    checker = resolveChecker(projectRoot, override);
  } catch (e) {
    return {
      name: "type checker",
      status: "fail",
      detail: (e as Error).message,
      fix: "install typescript (or the project's checker), or pass --checker",
    };
  }
  if (checker.source.includes("WARNING")) {
    return {
      name: "type checker",
      status: "fail",
      detail: `${checker.command} (${checker.source})`,
      fix: `run ${findPackageManager(projectRoot)} install so the declared checker is used`,
    };
  }
  // a resolved binary is quoted; scripts and --checker commands may do
  // anything, so they aren't run here
  const bin = /^"([^"]+)"/.exec(checker.command)?.[1];
  if (bin) {
    const result = await run(`"${bin}" --version`, { cwd: projectRoot });
    if (result.code !== 0) {
      return {
        name: "type checker",
        status: "fail",
        detail: `${bin} --version failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
        fix: `reinstall dependencies (${findPackageManager(projectRoot)} install)`,
      };
    }
    return {
      name: "type checker",
      status: "ok",
      detail: `${checker.source}: ${result.stdout.trim().split("\n")[0]}`,
    };
  }
  return { name: "type checker", status: "ok", detail: checker.source };
};

// --- tsconfig ---

const checkTsconfig = (projectRoot: string): Check => {
  const file = path.join(projectRoot, "tsconfig.json");
  if (!existsSync(file)) {
    return {
      name: "tsconfig",
      status: "fail",
      detail: `no tsconfig.json in ${projectRoot}; safebump's analysis reads it`,
      fix: "run safebump from the TypeScript project (or pass --root <dir with tsconfig.json>)",
    };
  }
  const refs = tsconfigReferences(projectRoot);
  const missing = refs.filter((r) => !existsSync(r));
  if (missing.length > 0) {
    return {
      name: "tsconfig",
      status: "fail",
      detail: `tsconfig.json references missing config(s): ${listed(missing.map((m) => path.relative(projectRoot, m)))}`,
    };
  }
  return {
    name: "tsconfig",
    status: "ok",
    detail: refs.length > 0 ? `tsconfig.json with ${refs.length} reference(s)` : "tsconfig.json",
  };
};

// --- git ---

const checkGit = async (projectRoot: string): Promise<Check> => {
  const top = await run("git rev-parse --show-toplevel", { cwd: projectRoot });
  if (top.code !== 0) {
    return {
      name: "git",
      status: "warn",
      detail: "not a git repository: no baseline to diff, audit or revert against",
      fix: "git init && git add -A && git commit -m baseline",
    };
  }
  const status = await run("git status --porcelain", { cwd: projectRoot });
  const changed = status.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ""))
    .filter((f) => !LOCKFILE_NAMES.includes(path.basename(f)));
  if (changed.length > 0) {
    return {
      name: "git",
      status: "warn",
      detail: `${changed.length} uncommitted change(s) besides lockfiles (${listed(changed)}); they'll be mixed into the upgrade's diff`,
      fix: "commit or stash them first, unless they're the upgrade itself",
    };
  }
  return { name: "git", status: "ok", detail: "working tree clean" };
};

// --- node version ---

const nodeVersion = process.versions.node;

const checkNode = async (projectRoot: string, packages: string[]): Promise<Check> => {
  const problems: string[] = [];
  const warnings: string[] = [];
  const root = installRoot(projectRoot);
  for (const dir of new Set([projectRoot, root])) {
    const range = readPackageJson(dir)?.engines?.node;
    if (range && !semver.satisfies(nodeVersion, range, { includePrerelease: true })) {
      warnings.push(`${path.relative(root, dir) || "."} requires node ${range}`);
    }
  }
  // version managers' pin files: the agent's shell may not have switched
  for (const file of [".nvmrc", ".node-version"]) {
    const pinned = [projectRoot, root]
      .map((d) => path.join(d, file))
      .find((f) => existsSync(f));
    if (!pinned) continue;
    const want = readFileSync(pinned, "utf-8").trim().replace(/^v/, "");
    const range = semver.validRange(want);
    if (range && !semver.satisfies(nodeVersion, range)) {
      warnings.push(`${file} pins ${want}`);
    }
  }

  const unresolved: string[] = [];
  await Promise.all(
    packages.map(async (target) => {
      const { name, spec } = parseTarget(target);
      try {
        const packument = await getPackument(projectRoot, name);
        const version = resolveVersion(packument, spec);
        const range = version && packument.versions[version]?.engines?.node;
        if (range && !semver.satisfies(nodeVersion, range, { includePrerelease: true })) {
          problems.push(`${name}@${version} requires node ${range}`);
        }
      } catch {
        unresolved.push(name);
      }
    }),
  );

  const notes = unresolved.length > 0 ? ` (couldn't check ${unresolved.join(", ")} in the registry)` : "";
  if (problems.length > 0) {
    return {
      name: "node",
      status: "fail",
      detail: `node ${nodeVersion}: ${[...problems, ...warnings].join("; ")}${notes}`,
      fix: "switch Node versions (nvm use / volta / fnm) before upgrading, and update engines/.nvmrc and CI to match",
    };
  }
  if (warnings.length > 0 || unresolved.length > 0) {
    return {
      name: "node",
      status: "warn",
      detail: `node ${nodeVersion}${warnings.length > 0 ? ": " + warnings.join("; ") : ""}${notes}`,
      fix: warnings.length > 0 ? "nvm use (or your version manager) in the shell running safebump" : undefined,
    };
  }
  return {
    name: "node",
    status: "ok",
    detail: `node ${nodeVersion} satisfies the project's and the targets' engines`,
  };
};

// --- duplicates ---

export type Duplicate = {
  name: string;
  versions: { version: string; paths: string[] }[];
};

export type DuplicateReport = {
  // the names and scopes searched, e.g. ["tamagui", "@tamagui/*"]
  searched: string[];
  // every matching package found, with its distinct versions
  found: number;
  duplicates: Duplicate[];
};

// a package and its scope family: "tamagui" also covers @tamagui/*,
// "@tamagui/core" covers @tamagui/*
const familyMatcher = (names: string[]) => {
  const exact = new Set(names);
  const scopes = new Set(
    names.map((n) => (n.startsWith("@") ? n.split("/")[0]! : `@${n}`)),
  );
  return {
    searched: [...names, ...Array.from(scopes, (s) => `${s}/*`)],
    scopes,
    matches: (name: string) =>
      exact.has(name) || (name.startsWith("@") && scopes.has(name.split("/")[0]!)),
  };
};

// pnpm and bun's isolated layout keep every version in a flat store:
// node_modules/.pnpm/@s+p@1.2.3_peer@4/node_modules/@s/p
const storeEntryName = (entry: string) => {
  const at = entry.indexOf("@", entry.startsWith("@") ? 1 : 0);
  if (at <= 0) return undefined;
  return entry.slice(0, at).replace("+", "/");
};

const MAX_DEPTH = 6;

export const findDuplicates = (
  projectRoot: string,
  names: string[],
): DuplicateReport => {
  const root = installRoot(projectRoot);
  const family = familyMatcher(names);
  const versions = new Map<string, Map<string, Set<string>>>();
  const visited = new Set<string>();

  const record = (pkgDir: string) => {
    const manifest = readPackageJson(pkgDir) as
      | { name?: string; version?: string }
      | undefined;
    if (!manifest?.name || !manifest.version || !family.matches(manifest.name)) return;
    const byVersion = versions.get(manifest.name) ?? new Map<string, Set<string>>();
    const paths = byVersion.get(manifest.version) ?? new Set<string>();
    // workspaces are linked into node_modules; show where the copy really is
    let real = pkgDir;
    try {
      real = realpathSync(pkgDir);
    } catch {
      // dangling link: keep the link's path
    }
    paths.add(path.relative(root, real));
    byVersion.set(manifest.version, paths);
    versions.set(manifest.name, byVersion);
  };

  const subdirs = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => e.name);
    } catch {
      return [];
    }
  };

  // walks a node_modules directory: matching packages are recorded, and
  // every package's nested node_modules is searched since a non-matching
  // dependency can carry its own copy
  const walk = (nodeModules: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    let real: string;
    try {
      real = realpathSync(nodeModules);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);

    for (const entry of subdirs(nodeModules)) {
      if (entry === ".pnpm" || entry === ".bun") {
        for (const stored of subdirs(path.join(nodeModules, entry))) {
          const name = storeEntryName(stored);
          if (name && family.matches(name)) {
            record(path.join(nodeModules, entry, stored, "node_modules", name));
          }
        }
        continue;
      }
      if (entry.startsWith(".")) continue;
      const pkgDirs = entry.startsWith("@")
        ? subdirs(path.join(nodeModules, entry)).map((p) => path.join(nodeModules, entry, p))
        : [path.join(nodeModules, entry)];
      for (const pkgDir of pkgDirs) {
        record(pkgDir);
        walk(path.join(pkgDir, "node_modules"), depth + 1);
      }
    }
  };

  const dirs = new Set([root, projectRoot, ...listWorkspaces(root).map((w) => w.dir)]);
  for (const dir of dirs) walk(path.join(dir, "node_modules"), 0);

  const duplicates: Duplicate[] = [];
  for (const [name, byVersion] of versions) {
    if (byVersion.size < 2) continue;
    duplicates.push({
      name,
      versions: Array.from(byVersion, ([version, paths]) => ({
        version,
        paths: Array.from(paths).sort(),
      })).sort((a, b) => semver.compare(semver.coerce(a.version) ?? "0.0.0", semver.coerce(b.version) ?? "0.0.0")),
    });
  }
  duplicates.sort((a, b) => a.name.localeCompare(b.name));
  return { searched: family.searched, found: versions.size, duplicates };
};

const checkDuplicates = (projectRoot: string, packages: string[]): Check => {
  const names = packages.map((p) => parseTarget(p).name);
  const report = findDuplicates(projectRoot, names);
  if (report.duplicates.length === 0) {
    return {
      name: "duplicates",
      status: "ok",
      detail: `one version each of ${report.found} package(s) matching ${report.searched.join(", ")}`,
    };
  }
  return {
    name: "duplicates",
    status: "warn",
    detail: `more than one version installed: ${listed(
      report.duplicates.map((d) => `${d.name} ${d.versions.map((v) => v.version).join(" + ")}`),
    )}`,
    fix: "align the declared ranges (or add overrides/resolutions) and reinstall; run `safebump duplicates <pkg>` for paths",
  };
};

export const runDoctor = async (
  projectRoot: string,
  options: { packages?: string[]; checker?: string } = {},
): Promise<DoctorReport> => {
  const packages = options.packages ?? [];
  const checks = await Promise.all([
    Promise.resolve(checkInstall(projectRoot)),
    checkLockfile(projectRoot),
    checkChecker(projectRoot, options.checker),
    Promise.resolve(checkTsconfig(projectRoot)),
    checkGit(projectRoot),
    checkNode(projectRoot, packages),
    ...(packages.length > 0 ? [Promise.resolve(checkDuplicates(projectRoot, packages))] : []),
  ]);
  return { ok: checks.every((c) => c.status !== "fail"), checks };
};

const ICONS: Record<CheckStatus, string> = { ok: "✔", warn: "!", fail: "✖" };

export const printDoctor = (r: DoctorReport) => {
  for (const c of r.checks) {
    console.log(`${ICONS[c.status]} ${c.name}: ${c.detail}`);
    if (c.fix && c.status !== "ok") console.log(`    fix: ${c.fix}`);
  }
  const failed = r.checks.filter((c) => c.status === "fail").length;
  console.log(
    r.ok
      ? "\nReady to upgrade."
      : `\n${failed} check(s) failed. Fix them before upgrading: errors from a broken setup look like upgrade breakage.`,
  );
};

export const printDuplicates = (r: DuplicateReport) => {
  if (r.duplicates.length === 0) {
    console.log(
      `No duplicates: ${r.found} package(s) matching ${r.searched.join(", ")}, one version each.`,
    );
    return;
  }
  console.log(
    `${r.duplicates.length} package(s) installed in more than one version (searched ${r.searched.join(", ")}):`,
  );
  for (const d of r.duplicates) {
    console.log(`\n## ${d.name}`);
    for (const v of d.versions) {
      console.log(`- ${v.version}: ${v.paths.join(", ")}`);
    }
  }
};
