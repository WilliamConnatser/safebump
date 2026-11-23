import { existsSync, readdirSync, readFileSync } from "fs";
import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import semver from "semver";

import { readPackageJson } from "./packages";
import { getPackument, resolveVersion, stableVersions } from "./registry";
import { run } from "./subprocess";

// Published packages are extracted into a pnpm-like layout so the TypeScript
// resolver can load one version's types without installing anything:
//
//   <cache>/packages/<name>@<version>/package/          the tarball contents
//   <cache>/packages/<name>@<version>/node_modules/...  symlinks to the
//     package itself, its @types and the dependencies its .d.ts files import
//
// Resolving "<name>" from a file in the version root then finds this exact
// version, and the dependencies' own roots repeat the layout.

export type FetchedPackage = {
  name: string;
  version: string;
  // resolve module names from a file in here to get this version's types
  root: string;
  dir: string;
  // @types/<name> when the package ships no types
  typesDir?: string;
};

const COMPLETE = ".safebump-complete";
const MAX_DEPTH = 4;

export const cacheDir = () =>
  path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "safebump",
    "packages",
  );

const NAME = /^(@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i;

export const typesPackageName = (name: string) =>
  `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;

// bare specifier "a/b/c" or "@s/a/b" -> package name
export const packageOf = (specifier: string) => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
};

type Manifest = {
  types?: string;
  typings?: string;
  main?: string;
  exports?: unknown;
  typesVersions?: unknown;
  dependencies?: Record<string, string>;
};

export const shipsTypes = (dir: string) => {
  const pkg = (readPackageJson(dir) ?? {}) as Manifest;
  if (pkg.types || pkg.typings || pkg.typesVersions) return true;
  if (JSON.stringify(pkg.exports ?? {}).includes('"types"')) return true;
  if (existsSync(path.join(dir, "index.d.ts"))) return true;
  const main = pkg.main?.replace(/\.(c|m)?js$/, "");
  return !!main && existsSync(path.join(dir, `${main}.d.ts`));
};

const dtsFiles = (dir: string, out: string[] = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) dtsFiles(full, out);
    else if (/\.d\.[cm]?ts$/.test(entry.name)) out.push(full);
  }
  return out;
};

// bare package names the .d.ts files import or reference
const importedPackages = (dir: string) => {
  const found = new Set<string>();
  const pattern =
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+|reference\s+types=)["']([^"'./][^"']*)["']/g;
  for (const file of dtsFiles(dir)) {
    for (const m of readFileSync(file, "utf-8").matchAll(pattern)) {
      found.add(packageOf(m[1]!));
    }
  }
  return found;
};

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const extract = async (projectRoot: string, name: string, version: string, dest: string) => {
  await mkdir(path.dirname(dest), { recursive: true });
  // staged next to the destination so the final rename stays on one filesystem
  const staging = await mkdtemp(path.join(path.dirname(dest), ".staging-"));
  try {
    // run in the project so its .npmrc (registry, auth) applies
    const packed = await run(
      `npm pack ${q(`${name}@${version}`)} --pack-destination ${q(staging)} --json --ignore-scripts --loglevel=error`,
      { cwd: projectRoot },
    );
    if (packed.code !== 0) {
      throw new Error(`npm pack ${name}@${version} failed: ${packed.stderr.trim().split("\n").slice(-3).join(" ")}`);
    }
    const filename = (JSON.parse(packed.stdout) as { filename: string }[])[0]?.filename;
    if (!filename) throw new Error(`npm pack ${name}@${version} produced no tarball`);
    const out = path.join(staging, "out");
    await mkdir(out);
    const untar = await run(
      `tar -xzf ${q(path.join(staging, path.basename(filename)))} -C ${q(out)} --no-same-owner --no-same-permissions`,
      { cwd: staging },
    );
    if (untar.code !== 0) throw new Error(`tar failed for ${name}@${version}: ${untar.stderr.trim()}`);
    // the top-level directory is usually "package/" but not always
    const [top] = await readdir(out);
    if (!top) throw new Error(`empty tarball for ${name}@${version}`);
    await rm(dest, { recursive: true, force: true });
    await rename(path.join(out, top), dest);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

const link = async (root: string, name: string, target: string) => {
  const at = path.join(root, "node_modules", name);
  await mkdir(path.dirname(at), { recursive: true });
  await rm(at, { recursive: true, force: true });
  await symlink(path.relative(path.dirname(at), target), at, "dir");
};

const resolveTypesVersion = async (projectRoot: string, name: string, version: string) => {
  const p = await getPackument(projectRoot, typesPackageName(name)).catch(() => undefined);
  if (!p) return undefined;
  const versions = stableVersions(p);
  return (
    semver.maxSatisfying(versions, `${semver.major(version)}.x`) ??
    p["dist-tags"].latest
  );
};

const inflight = new Map<string, Promise<FetchedPackage>>();

const fetchOne = async (
  projectRoot: string,
  name: string,
  version: string,
  depth: number,
): Promise<FetchedPackage> => {
  const root = path.join(cacheDir(), `${name}@${version}`);
  const dir = path.join(root, "package");
  const typesLink = path.join(root, "node_modules", typesPackageName(name));
  const result = (): FetchedPackage => ({
    name,
    version,
    root,
    dir,
    typesDir: existsSync(typesLink) ? typesLink : undefined,
  });
  if (existsSync(path.join(root, COMPLETE))) return result();

  await rm(path.join(root, "node_modules"), { recursive: true, force: true });
  await extract(projectRoot, name, version, dir);
  await link(root, name, dir);

  const manifest = (readPackageJson(dir) ?? {}) as Manifest;
  const deps = manifest.dependencies ?? {};
  const wanted: [string, string][] = [];

  if (!name.startsWith("@types/") && !shipsTypes(dir)) {
    const typesVersion = await resolveTypesVersion(projectRoot, name, version);
    if (typesVersion) wanted.push([typesPackageName(name), typesVersion]);
  }

  if (depth < MAX_DEPTH) {
    // only dependencies the declarations import; the rest don't affect types
    for (const imported of importedPackages(dir)) {
      for (const dep of [imported, typesPackageName(imported)]) {
        const range = deps[dep];
        if (!range || dep === name) continue;
        const p = await getPackument(projectRoot, dep).catch(() => undefined);
        const v = p && resolveVersion(p, range);
        if (v) wanted.push([dep, v]);
      }
    }
  }

  await Promise.all(
    wanted.map(async ([dep, v]) => {
      // a missing dependency falls back to the project's copy when resolving
      const fetched = await fetchVersion(projectRoot, dep, v, depth + 1).catch(() => undefined);
      if (fetched) await link(root, dep, fetched.dir);
    }),
  );

  await writeFile(path.join(root, COMPLETE), "");
  return result();
};

const fetchVersion = (projectRoot: string, name: string, version: string, depth: number) => {
  if (!NAME.test(name) || !semver.valid(version)) {
    return Promise.reject(new Error(`Invalid package spec ${name}@${version}`));
  }
  const key = `${name}@${version}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchOne(projectRoot, name, version, depth);
    inflight.set(key, pending);
    pending.catch(() => inflight.delete(key));
  }
  return pending;
};

// Downloads and extracts `name@version` (an exact version) into the cache,
// plus @types/<name> if it ships no types and the dependencies its types
// import. Cached across runs.
export const fetchPackage = (projectRoot: string, name: string, version: string) =>
  fetchVersion(projectRoot, name, version, 0);
