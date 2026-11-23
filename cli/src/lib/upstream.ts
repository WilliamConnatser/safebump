import { execFile } from "child_process";
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { mkdir, rm } from "fs/promises";
import os from "os";
import path from "path";
import semver from "semver";

import { installedVersion } from "./packages";
import { getManifest as registryManifest, getPackument, resolveVersion } from "./registry";

// How the package's maintainers migrated their own examples, docs and tests
// between two releases. Those diffs are before/after pairs written by the
// people who made the breaking change, which beat changelog prose as context
// for a fix agent.
//
// The repository is fetched as a shallow, blob-less partial clone into
// <cache>/repos/<owner>__<repo>: only the two commits' trees come down up
// front, and `git diff` then fetches just the blobs of the files we show.

export type UpstreamFile = {
  path: string;
  score: number;
  added: number;
  removed: number;
  // present for the top files only
  diff?: string;
};

export type RefHow = "gitHead" | "tag" | "nearest-tag" | "explicit";

export type UpstreamResult = {
  package: string;
  from: string;
  to: string;
  repo?: string;
  directory?: string;
  fromRef?: string;
  toRef?: string;
  // the least exact of the two sides
  how?: RefHow;
  fromHow?: RefHow;
  toHow?: RefHow;
  compareUrl?: string;
  // names from the package the project imports, used for ranking
  names: string[];
  changedFiles: number;
  candidates: number;
  files: UpstreamFile[];
  // relevant-looking files not listed
  omitted: number;
  notes: string[];
  error?: string;
};

export type UpstreamOptions = {
  maxFiles?: number;
  maxLines?: number;
  // override the imported names used for ranking
  names?: string[];
  // explicit commits/tags when the registry has neither gitHead nor a tag
  fromRef?: string;
  toRef?: string;
};

const MAX_CANDIDATES = 500;
const MAX_LISTED = 40;
const GIT_TIMEOUT = 180_000;

type GitResult = { code: number; stdout: string; stderr: string };

// execFile rather than the shell: refs and paths come from the network
// Lazy fetching is off unless asked for: in a partial clone, merely asking
// whether a missing commit exists downloads it with its entire history.
const git = (args: string[], cwd: string, opts: { lazy?: boolean; timeout?: number } = {}) =>
  new Promise<GitResult>((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: opts.timeout ?? GIT_TIMEOUT,
        maxBuffer: 512 * 1024 * 1024,
        env: {
          ...process.env,
          // never hang on a credential prompt for a private repo
          GIT_TERMINAL_PROMPT: "0",
          ...(opts.lazy ? {} : { GIT_NO_LAZY_FETCH: "1" }),
        },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stdout, stderr: err && !stderr ? err.message : stderr });
      },
    );
  });

const lastLines = (s: string, n = 3) => s.trim().split("\n").slice(-n).join(" ");

export const reposCacheDir = () =>
  path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "safebump",
    "repos",
  );

// --- repository field ---------------------------------------------------

export type RepoInfo = {
  cloneUrl: string;
  web: string;
  host: string;
  owner: string;
  name: string;
  directory?: string;
};

type RepositoryField = string | { url?: string; directory?: string } | undefined;

const HOSTS: Record<string, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};

export const parseRepository = (repository: RepositoryField): RepoInfo | undefined => {
  let url = typeof repository === "string" ? repository : repository?.url;
  let directory = typeof repository === "object" ? repository.directory : undefined;
  if (!url) return undefined;
  url = url.trim().replace(/#.*$/, "");

  // shorthands: "owner/repo", "github:owner/repo", "gitlab:owner/repo"
  const short = /^(?:(github|gitlab|bitbucket):)?([\w.-]+)\/([\w.-]+)$/.exec(url);
  if (short) url = `https://${HOSTS[short[1] ?? "github"]}/${short[2]}/${short[3]}`;

  url = url
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//, "https://$1/")
    .replace(/^(?:[^@/]+@)([^/:]+):/, "https://$1/")
    .replace(/^http:\/\//, "https://");

  const m = /^https:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|blob)\/[^/]+\/(.+?))?\/?$/.exec(url);
  if (!m) return undefined;
  const [, host, owner, name, treeDir] = m;
  directory = (directory ?? treeDir)?.replace(/^\.?\/+|\/+$/g, "") || undefined;
  return {
    cloneUrl: `https://${host}/${owner}/${name}.git`,
    web: `https://${host}/${owner}/${name}`,
    host: host!,
    owner: owner!,
    name: name!,
    directory,
  };
};

type Manifest = { repository?: RepositoryField; gitHead?: string };

// registry.ts getManifest's type omits gitHead and repository.directory
const getManifest = async (cwd: string, name: string, version: string) =>
  (await registryManifest(cwd, name, version).catch(() => undefined)) as Manifest | undefined;

// --- tags -----------------------------------------------------------------

type Tag = { name: string; sha: string };

const lsRemoteTags = async (url: string, cwd: string) => {
  const r = await git(["ls-remote", "--tags", url], cwd, { timeout: 60_000 });
  if (r.code !== 0) throw new Error(`git ls-remote ${url} failed: ${lastLines(r.stderr)}`);
  const tags = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (!sha || !ref?.startsWith("refs/tags/")) continue;
    const peeled = ref.endsWith("^{}");
    const name = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
    // annotated tags list the tag object, then the commit as name^{}
    if (peeled || !tags.has(name)) tags.set(name, sha);
  }
  return tags;
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// per-package families first in monorepos, repo-wide ones first otherwise
const tagTemplates = (pkg: string, monorepo: boolean) => {
  const base = pkg.split("/").pop()!;
  const own = [`${pkg}@{v}`, `${pkg}@v{v}`, `${base}@{v}`, `${base}@v{v}`, `${base}-v{v}`, `${base}-{v}`];
  const repo = ["v{v}", "{v}", "release-{v}"];
  return {
    own: Array.from(new Set(own)),
    repo,
    ordered: monorepo ? [...own, ...repo] : [...repo, ...own],
  };
};

const pickTag = (
  tags: Map<string, string>,
  pkg: string,
  version: string,
  monorepo: boolean,
): (Tag & { how: RefHow }) | undefined => {
  const t = tagTemplates(pkg, monorepo);
  for (const tpl of t.ordered) {
    const name = tpl.replace("{v}", version);
    const sha = tags.get(name);
    if (sha) return { name, sha, how: "tag" };
  }

  // a repo-wide v1.2.3 in a monorepo may belong to another package, so only
  // trust the nearest one when the package has no tags of its own
  const ownFamilies = t.own.filter((tpl) => familyOf(tags, tpl).length > 0);
  const families = monorepo && ownFamilies.length > 0 ? ownFamilies : t.ordered;
  for (const tpl of families) {
    const candidates = familyOf(tags, tpl).filter(
      (c) =>
        semver.major(c.version) === semver.major(version) &&
        (!semver.prerelease(c.version) || !!semver.prerelease(version)),
    );
    if (candidates.length === 0) continue;
    const below = candidates.filter((c) => semver.lte(c.version, version));
    const best = below.length > 0
      ? below.sort((a, b) => semver.rcompare(a.version, b.version))[0]!
      : candidates.sort((a, b) => semver.compare(a.version, b.version))[0]!;
    return { name: best.name, sha: tags.get(best.name)!, how: "nearest-tag" };
  }
  return undefined;
};

const familyOf = (tags: Map<string, string>, tpl: string) => {
  const re = new RegExp(`^${escape(tpl).replace(escape("{v}"), "(\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?)")}$`);
  const out: { name: string; version: string }[] = [];
  for (const name of tags.keys()) {
    const v = re.exec(name)?.[1];
    if (v && semver.valid(v)) out.push({ name, version: v });
  }
  return out;
};

// --- cache repo -------------------------------------------------------------

const ensureRepo = async (repo: RepoInfo) => {
  const key = (repo.host === "github.com" ? [repo.owner, repo.name] : [repo.host, repo.owner, repo.name])
    .join("__")
    .replace(/[^\w.-]/g, "_");
  const dir = path.join(reposCacheDir(), key);
  if (existsSync(dir) && (await git(["rev-parse", "--git-dir"], dir)).code === 0) return dir;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const args of [
    ["init", "-q", "--bare"],
    ["remote", "add", "origin", repo.cloneUrl],
    // what clone --filter=blob:none sets: blobs are fetched on demand
    ["config", "remote.origin.promisor", "true"],
    ["config", "remote.origin.partialclonefilter", "blob:none"],
    ["config", "gc.auto", "0"],
  ]) {
    const r = await git(args, dir);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${lastLines(r.stderr)}`);
  }
  return dir;
};

// each fetched commit is kept under its own ref: checking a ref never
// triggers a fetch, and gc won't prune what a ref points to
const keepRef = (spec: string) => `refs/safebump/${createHash("sha1").update(spec).digest("hex")}`;

const keptCommit = async (dir: string, spec: string) => {
  const r = await git(["rev-parse", "--verify", "--quiet", `${keepRef(spec)}^{commit}`], dir);
  return r.code === 0 ? r.stdout.trim() : undefined;
};

// only these commits and their trees; history isn't needed for a diff
const fetchCommits = async (dir: string, specs: string[]) => {
  if (specs.length === 0) return { code: 0, stdout: "", stderr: "" };
  return git(
    ["fetch", "-q", "--depth=1", "--filter=blob:none", "--no-tags", "origin", ...specs.map((s) => `+${s}:${keepRef(s)}`)],
    dir,
  );
};

type Side = { ref: string; how: RefHow; fetchSpec: string; sha?: string };

const resolveSides = async (
  projectRoot: string,
  dir: string,
  repo: RepoInfo,
  pkg: string,
  versions: { version: string; gitHead?: string; explicit?: string }[],
  notes: string[],
) => {
  let tags: Map<string, string> | undefined;
  const loadTags = async () => (tags ??= await lsRemoteTags(repo.cloneUrl, projectRoot));
  const monorepo = !!repo.directory;

  const byTag = async (version: string): Promise<Side | undefined> => {
    const tag = pickTag(await loadTags(), pkg, version, monorepo);
    if (!tag) return undefined;
    if (tag.how === "nearest-tag") notes.push(`No tag for ${version}; using nearest tag ${tag.name}.`);
    return { ref: tag.name, how: tag.how, fetchSpec: `refs/tags/${tag.name}` };
  };

  const pick = async (v: (typeof versions)[number]): Promise<Side | undefined> => {
    if (v.explicit) {
      const spec = /^[0-9a-f]{40}$/.test(v.explicit) || v.explicit.startsWith("refs/") ? v.explicit : `refs/tags/${v.explicit}`;
      return { ref: v.explicit, how: "explicit", fetchSpec: spec };
    }
    // gitHead is the exact commit npm published from
    if (v.gitHead) return { ref: v.gitHead.slice(0, 12), how: "gitHead", fetchSpec: v.gitHead };
    return byTag(v.version);
  };

  const sides = await Promise.all(versions.map(pick));
  const missing = versions.filter((_, i) => !sides[i]).map((v) => v.version);
  if (missing.length > 0) {
    throw new Error(
      `No gitHead in the registry and no matching tag in ${repo.web} for ${missing.join(", ")}. Pass explicit refs (fromRef/toRef).`,
    );
  }

  const fetchMissing = async () => {
    const need: string[] = [];
    for (const s of sides as Side[]) if (!(await keptCommit(dir, s.fetchSpec))) need.push(s.fetchSpec);
    return fetchCommits(dir, need);
  };
  let fetched = await fetchMissing();
  if (fetched.code !== 0) {
    // hosts that refuse fetching by sha, or a gitHead never pushed: use tags
    for (let i = 0; i < sides.length; i++) {
      if (sides[i]!.how === "gitHead" && !(await keptCommit(dir, sides[i]!.fetchSpec))) {
        const tag = await byTag(versions[i]!.version).catch(() => undefined);
        if (tag) {
          notes.push(`gitHead ${sides[i]!.ref} of ${versions[i]!.version} could not be fetched; using tag ${tag.ref}.`);
          sides[i] = tag;
        }
      }
    }
    fetched = await fetchMissing();
  }
  for (const s of sides as Side[]) s.sha = await keptCommit(dir, s.fetchSpec);
  if (fetched.code !== 0 || sides.some((s) => !s!.sha)) {
    throw new Error(
      `git fetch from ${repo.cloneUrl} failed (private repo, network, or the commit is gone): ${lastLines(fetched.stderr)}`,
    );
  }
  return sides as (Side & { sha: string })[];
};

// --- project imports ------------------------------------------------------------

const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".safebump", "coverage", ".expo", ".turbo"]);

const sourceFiles = (dir: string, out: string[] = [], limit = 5000) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= limit) break;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) sourceFiles(path.join(dir, e.name), out, limit);
    } else if (SOURCE.test(e.name) && !e.name.endsWith(".d.ts")) out.push(path.join(dir, e.name));
  }
  return out;
};

// A quick regex scan, not ts-morph: it only ranks diffs, so speed matters
// more than catching every re-export. Default and namespace imports add the
// local name and the members accessed through it (Camera.useCameraPermissions).
export const importedNames = (projectRoot: string, pkg: string) => {
  const names = new Set<string>();
  const spec = `${escape(pkg)}(?:/[^"']*)?`;
  const fromRe = new RegExp(`import\\s+(?:type\\s+)?([^;]*?)\\s+from\\s+["']${spec}["']`, "g");
  const requireRe = new RegExp(`(?:const|let|var)\\s+([^=]+?)\\s*=\\s*require\\(\\s*["']${spec}["']\\s*\\)`, "g");
  for (const file of sourceFiles(projectRoot)) {
    let text: string;
    try {
      if (statSync(file).size > 1_000_000) continue;
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (!text.includes(pkg)) continue;
    for (const m of [...text.matchAll(fromRe), ...text.matchAll(requireRe)]) {
      const clause = m[1]!;
      const braces = /\{([^}]*)\}/.exec(clause)?.[1];
      for (const part of braces?.split(",") ?? []) {
        const name = part.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0]!.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
      const outside = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+/, "");
      for (const local of outside.split(",").map((s) => s.trim())) {
        if (!/^[A-Za-z_$][\w$]*$/.test(local) || local === "type") continue;
        names.add(local);
        for (const a of text.matchAll(new RegExp(`\\b${escape(local)}\\.([A-Za-z_$][\\w$]*)`, "g"))) names.add(a[1]!);
      }
    }
  }
  // a name that is also a global (Response, URL) matches unrelated code
  return Array.from(names)
    .filter((n) => !(n in globalThis))
    .sort();
};

// --- path selection -----------------------------------------------------------

const EXCLUDED = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
  /(^|\/)(dist|build|out|coverage|node_modules|\.next|generated|__generated__|vendor)\//,
  /\.(min\.js|map)$/,
  /(^|\/)CHANGELOG(\.md)?$/i,
  /\.generated\./,
];
const USAGE_DIR = /(^|\/)(examples?|docs?|documentation|playground|demos?|samples?|__tests__|tests?|e2e|integrations?|apps)\//;
const USAGE_FILE = /\.(test|spec|test-d|bench)\.[cm]?[jt]sx?$/;
const TEXT = /\.(?:[cm]?[jt]sx?|mdx?|vue|svelte|astro)$/;

const isUsage = (file: string, pkgDir?: string) => {
  if (!TEXT.test(file) || EXCLUDED.some((r) => r.test(file))) return false;
  if (path.posix.dirname(file) === (pkgDir ?? ".") && /^(README|MIGRATION|UPGRADING)/i.test(path.posix.basename(file))) return true;
  if (MIGRATION_GUIDE.test(file)) return true;
  const rel = pkgDir && file.startsWith(`${pkgDir}/`) ? file.slice(pkgDir.length + 1) : file;
  return USAGE_DIR.test(rel) || USAGE_FILE.test(rel);
};

const STOP = new Set(["core", "utils", "util", "plugin", "types", "client", "sdk", "lib", "js", "node"]);

// path words that identify the package: "camera" for expo-camera, "react"
// for @tanstack/react-query; words in the repo name say nothing there
const distinctive = (pkg: string, repoName: string) =>
  pkg
    .split("/")
    .pop()!
    .toLowerCase()
    .split(/[-_.]/)
    .filter((t) => t.length >= 3 && !STOP.has(t) && !repoName.toLowerCase().includes(t));

// another package of the monorepo (packages/vue-query when we want
// packages/react-query): its tests use the same names for something else
const isSibling = (file: string, pkgDir?: string) => {
  if (!pkgDir || file.startsWith(`${pkgDir}/`)) return false;
  const parent = path.posix.dirname(pkgDir);
  return parent !== "." && file.startsWith(`${parent}/`);
};

const MIGRATION_GUIDE = /(^|\/)[^/]*(migrat|upgrad|breaking)[^/]*\.mdx?$/i;

const kindWeight = (file: string) =>
  /(^|\/)(examples?|playground|demos?|samples?)\//.test(file) ? 2 : /(^|\/)(docs?|documentation)\/|\.mdx?$/.test(file) ? 1.5 : 1;

// which of thousands of changed files get their blobs fetched
const prioritize = (files: string[], pkg: string, repoName: string, pkgDir?: string) => {
  const tokens = distinctive(pkg, repoName);
  const named = (f: string) => tokens.some((t) => new RegExp(`(^|[/._-])${escape(t)}([/._-]|$)`, "i").test(f));
  const rank = (f: string) => {
    if (pkgDir && f.startsWith(`${pkgDir}/`)) return 0;
    const sibling = isSibling(f, pkgDir);
    if (!sibling && named(f)) return 1;
    if (!sibling) return 2;
    return named(f) ? 3 : 4;
  };
  return files
    .map((f) => ({ f, r: rank(f) }))
    .sort((a, b) => a.r - b.r || kindWeight(b.f) - kindWeight(a.f) || a.f.localeCompare(b.f))
    .map((x) => x.f);
};

// --- diff parsing and scoring -----------------------------------------------------

type Hunk = { text: string; score: number; lines: number };
type FileDiff = { path: string; added: number; removed: number; header: string; hunks: Hunk[] };

const parseDiff = (out: string): FileDiff[] => {
  const files: FileDiff[] = [];
  for (const chunk of out.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue;
    const lines = chunk.split("\n");
    const target = lines.find((l) => l.startsWith("+++ "));
    const source = lines.find((l) => l.startsWith("--- "));
    const pick = (l?: string) => l?.slice(4).replace(/^"|"$/g, "");
    const name =
      pick(target) !== "/dev/null" ? pick(target)?.replace(/^b\//, "") : pick(source)?.replace(/^a\//, "");
    if (!name) continue; // binary or mode-only
    const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
    const file: FileDiff = { path: name, added: 0, removed: 0, header: "", hunks: [] };
    file.header = lines.slice(0, firstHunk).filter((l) => /^(new|deleted) file|^rename from/.test(l)).join("\n");
    let current: string[] | undefined;
    const flush = () => {
      if (current) file.hunks.push({ text: current.join("\n"), score: 0, lines: current.length });
    };
    for (const line of lines.slice(firstHunk)) {
      if (line.startsWith("@@")) {
        flush();
        current = [line];
      } else if (current && line !== "" && !line.startsWith("\\")) {
        current.push(line);
        if (line[0] === "+") file.added++;
        else if (line[0] === "-") file.removed++;
      }
    }
    flush();
    files.push(file);
  }
  return files;
};

// imported names on changed lines; a hunk that only adds or only removes
// shows no before/after pair, so it counts for less
const scoreHunk = (hunk: Hunk, names: RegExp | undefined, pkg: string) => {
  let hits = 0;
  let plus = false;
  let minus = false;
  for (const line of hunk.text.split("\n").slice(1)) {
    if (line[0] === "+") plus = true;
    else if (line[0] === "-") minus = true;
    else continue;
    if (names) hits += line.match(names)?.length ?? 0;
    if (line.includes(pkg)) hits += 1;
  }
  return plus && minus ? hits : hits / 5;
};

// log-scaled so one huge test file doesn't drown out the examples
const fileScore = (f: FileDiff, own: boolean, pkgDir?: string) => {
  const hits = f.hunks.reduce((s, h) => s + h.score, 0);
  if (hits === 0) return 0;
  // a whole new or deleted file shows no before/after (moves are paired by -M)
  // except a migration guide, which holds before/after pairs itself
  // (new, or the package's top-level MIGRATION.md)
  const guide =
    MIGRATION_GUIDE.test(f.path) &&
    (f.removed === 0 || path.posix.dirname(f.path) === (pkgDir ?? "."));
  const oneSided = !guide && (f.added === 0 || f.removed === 0) ? 4 : 1;
  const score = 10 * (guide ? 3 : kindWeight(f.path)) * Math.log2(1 + hits);
  return Math.max(1, Math.round(score / oneSided / (own ? 1 : 4)));
};

// --- main -----------------------------------------------------------------

const resolveVersions = async (projectRoot: string, pkg: string, from?: string, to?: string) => {
  const packument = await getPackument(projectRoot, pkg);
  const fromV = from ? resolveVersion(packument, from) : installedVersion(projectRoot, pkg);
  const toV = resolveVersion(packument, to);
  if (!fromV) throw new Error(`${pkg} isn't installed and no "from" version was given (or it matched nothing).`);
  if (!toV) throw new Error(`No version of ${pkg} matches "${to}".`);
  return [fromV, toV] as const;
};

const weakest = (a: RefHow, b: RefHow): RefHow => {
  const order: RefHow[] = ["nearest-tag", "tag", "explicit", "gitHead"];
  return order[Math.min(order.indexOf(a), order.indexOf(b))]!;
};

export const upstreamExamples = async (
  projectRoot: string,
  pkg: string,
  from?: string,
  to?: string,
  options: UpstreamOptions = {},
): Promise<UpstreamResult> => {
  const maxFiles = options.maxFiles ?? 8;
  const maxLines = options.maxLines ?? 400;
  const result: UpstreamResult = {
    package: pkg,
    from: from ?? "",
    to: to ?? "",
    names: [],
    changedFiles: 0,
    candidates: 0,
    files: [],
    omitted: 0,
    notes: [],
  };
  try {
    const [fromV, toV] = await resolveVersions(projectRoot, pkg, from, to);
    Object.assign(result, { from: fromV, to: toV });

    const [mFrom, mTo] = await Promise.all([
      getManifest(projectRoot, pkg, fromV),
      getManifest(projectRoot, pkg, toV),
    ]);
    const repo = parseRepository(mTo?.repository) ?? parseRepository(mFrom?.repository);
    if (!repo) {
      throw new Error(`${pkg}@${toV} has no usable "repository" field in the registry, so its source can't be located.`);
    }
    result.repo = repo.web;
    result.directory = repo.directory;

    const started = Date.now();
    const dir = await ensureRepo(repo);
    const [a, b] = await resolveSides(
      projectRoot,
      dir,
      repo,
      pkg,
      [
        { version: fromV, gitHead: mFrom?.gitHead, explicit: options.fromRef },
        { version: toV, gitHead: mTo?.gitHead, explicit: options.toRef },
      ],
      result.notes,
    );
    Object.assign(result, {
      fromRef: a!.ref,
      toRef: b!.ref,
      fromHow: a!.how,
      toHow: b!.how,
      how: weakest(a!.how, b!.how),
    });
    if (repo.host === "github.com") {
      const enc = (r: string) => encodeURIComponent(r);
      result.compareUrl = `${repo.web}/compare/${enc(a!.ref)}...${enc(b!.ref)}`;
    }

    // tree-only listing: no blobs fetched yet
    const listing = await git(["-c", "core.quotepath=off", "diff", "--name-only", "--no-renames", "-z", a!.sha, b!.sha], dir);
    if (listing.code !== 0) throw new Error(`git diff failed: ${lastLines(listing.stderr)}`);
    const changed = listing.stdout.split("\0").filter(Boolean);
    result.changedFiles = changed.length;
    const usage = prioritize(changed.filter((f) => isUsage(f, repo.directory)), pkg, repo.name, repo.directory);
    result.candidates = usage.length;
    const selected = usage.slice(0, MAX_CANDIDATES);
    if (usage.length > selected.length) {
      result.notes.push(
        `${usage.length} changed example/doc/test files; ranked the ${selected.length} nearest to ${repo.directory ?? "the package"}.`,
      );
    }
    if (selected.length === 0) {
      result.notes.push(`None of the ${changed.length} changed files are examples, docs or tests.`);
      return result;
    }

    // fetches only these files' blobs, in one batch
    const diff = await git(
      ["--literal-pathspecs", "-c", "core.quotepath=off", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M50%", "--src-prefix=a/", "--dst-prefix=b/", a!.sha, b!.sha, "--", ...selected],
      dir,
      { lazy: true },
    );
    if (diff.code !== 0) throw new Error(`git diff failed while fetching file contents: ${lastLines(diff.stderr)}`);

    // files whose either version mentions the package, for monorepos where
    // sibling packages' examples use the same names
    const mentions = new Set<string>();
    if (repo.directory) {
      for (const sha of [a!.sha, b!.sha]) {
        const g = await git(["--literal-pathspecs", "grep", "-l", "-F", "-e", pkg, sha, "--", ...selected], dir, { lazy: true });
        for (const line of g.stdout.split("\n")) if (line) mentions.add(line.slice(sha.length + 1));
      }
    }

    result.names = options.names ?? importedNames(projectRoot, pkg);
    if (result.names.length === 0) {
      result.notes.push(`No imports of ${pkg} found in the project; ranked by mentions of the package name.`);
    }
    const namesRe =
      result.names.length > 0
        ? new RegExp(`\\b(?:${result.names.map(escape).join("|")})\\b`, "g")
        : undefined;

    const scored = parseDiff(diff.stdout).map((f) => {
      for (const h of f.hunks) h.score = scoreHunk(h, namesRe, pkg);
      const own =
        !repo.directory ||
        f.path.startsWith(`${repo.directory}/`) ||
        (mentions.has(f.path) && !isSibling(f.path, repo.directory));
      return { f, score: fileScore(f, own, repo.directory), own };
    });
    const relevant = scored
      .filter((s) => s.score > 0 || s.own)
      .sort((x, y) => y.score - x.score || (y.f.added + y.f.removed) - (x.f.added + x.f.removed));

    let budget = maxLines;
    const perFile = Math.max(30, Math.round((maxLines / maxFiles) * 1.25));
    for (const [i, { f, score }] of relevant.entries()) {
      const entry: UpstreamFile = { path: f.path, score, added: f.added, removed: f.removed };
      if (i < maxFiles && budget > 0 && score > 0) {
        entry.diff = renderHunks(f, Math.min(perFile, budget));
        budget -= entry.diff.split("\n").length;
      }
      if (entry.diff || result.files.length < maxFiles + MAX_LISTED) result.files.push(entry);
    }
    result.omitted = relevant.length - result.files.length + (usage.length - selected.length);
    result.notes.push(`Fetched in ${((Date.now() - started) / 1000).toFixed(1)}s (cache: ${dir}).`);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }
  return result;
};

// the densest hunks that use an imported name, in file order, within the
// line budget; truncates one hunk only when none fits whole
const renderHunks = (f: FileDiff, budget: number) => {
  const head = f.header ? [f.header] : [];
  let room = budget - head.length;
  const byDensity = f.hunks
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h.score > 0)
    .sort((x, y) => y.h.score / y.h.lines - x.h.score / x.h.lines);
  const chosen = new Set<number>();
  for (const { h, i } of byDensity) {
    if (h.lines <= room) {
      chosen.add(i);
      room -= h.lines;
    }
  }
  const out = [...head];
  if (chosen.size === 0 && byDensity[0]) {
    const lines = byDensity[0].h.text.split("\n");
    out.push(...lines.slice(0, room), `… (${lines.length - room} more lines in this hunk)`);
    chosen.add(byDensity[0].i);
  } else {
    f.hunks.forEach((h, i) => chosen.has(i) && out.push(h.text));
  }
  const skipped = f.hunks.length - chosen.size;
  if (skipped > 0) out.push(`… (${skipped} more hunks not shown)`);
  return out.join("\n");
};

export const printUpstream = (r: UpstreamResult) => {
  console.log(`# ${r.package} ${r.from} → ${r.to}: upstream examples, docs and tests`);
  if (r.error) {
    console.log(`Could not get the upstream diff: ${r.error}`);
    for (const n of r.notes) console.log(`note: ${n}`);
    return;
  }
  console.log(
    `${r.repo}${r.directory ? ` (${r.directory})` : ""}: ${r.fromRef} (${r.fromHow}) → ${r.toRef} (${r.toHow})`,
  );
  if (r.compareUrl) console.log(`compare: ${r.compareUrl}`);
  console.log(
    `${r.changedFiles} files changed; ${r.candidates} are examples/docs/tests. Ranked by ${r.names.length > 0 ? `${r.names.length} names the project imports` : "mentions of the package"}.`,
  );
  for (const n of r.notes) console.log(`note: ${n}`);

  const shown = r.files.filter((f) => f.diff);
  if (shown.length === 0) console.log("\nNo changed example, doc or test touches what this project uses.");
  for (const f of shown) {
    console.log(`\n## ${f.path} (+${f.added} -${f.removed}, score ${f.score})`);
    console.log("```diff");
    console.log(f.diff);
    console.log("```");
  }
  const rest = r.files.filter((f) => !f.diff);
  if (rest.length > 0 || r.omitted > 0) {
    console.log(`\n## Other changed files`);
    for (const f of rest) console.log(`- ${f.path} (+${f.added} -${f.removed}, score ${f.score})`);
    if (r.omitted > 0) console.log(`(+${r.omitted} more)`);
  }
};

// --- for other modules ----------------------------------------------------------

export type ResolvedSide = { version: string; ref: string; how: RefHow; sha: string };
export type ResolvedCommits = { repo: RepoInfo; dir: string; from: ResolvedSide; to: ResolvedSide; notes: string[] };

// The cache repo with both versions' commits (trees only) fetched, for
// callers that read blobs themselves through gitIn.
export const resolveCommits = async (
  projectRoot: string,
  pkg: string,
  from: string,
  to: string,
  refs: { fromRef?: string; toRef?: string } = {},
): Promise<ResolvedCommits> => {
  const [mFrom, mTo] = await Promise.all([getManifest(projectRoot, pkg, from), getManifest(projectRoot, pkg, to)]);
  const repo = parseRepository(mTo?.repository) ?? parseRepository(mFrom?.repository);
  if (!repo) throw new Error(`${pkg}@${to} has no usable "repository" field in the registry.`);
  const dir = await ensureRepo(repo);
  const notes: string[] = [];
  const [a, b] = await resolveSides(
    projectRoot,
    dir,
    repo,
    pkg,
    [
      { version: from, gitHead: mFrom?.gitHead, explicit: refs.fromRef },
      { version: to, gitHead: mTo?.gitHead, explicit: refs.toRef },
    ],
    notes,
  );
  const side = (s: Side & { sha: string }, version: string): ResolvedSide => ({ version, ref: s.ref, how: s.how, sha: s.sha });
  return { repo, dir, from: side(a!, from), to: side(b!, to), notes };
};

// git in the cache repo; lazy fetching stays off unless asked for
export const gitIn = (dir: string, args: string[], opts: { lazy?: boolean; timeout?: number } = {}) => git(args, dir, opts);
