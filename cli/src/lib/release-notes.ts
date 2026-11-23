import { execFile } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import semver from "semver";

import { fetchPackage } from "./fetch-package";
import { getManifest, getPackument } from "./registry";
import { run } from "./subprocess";
import { DOC_FILE } from "./typescript/analyze";
import { parseRepository, reposCacheDir, type RepoInfo } from "./upstream";

// What the maintainers wrote about every version an upgrade crosses, so a
// review agent without web access can read it next to the APIs the project
// uses. Sources, best first: GitHub releases, the CHANGELOG shipped in the
// target tarball, and the registry (versions and dates only).
//
// GitHub responses are cached under <cache>/releases/<owner>__<repo>/ for a
// few hours: unauthenticated clients get 60 requests an hour.

export type ReleaseNote = {
  version: string;
  date?: string;
  source: "github-release" | "changelog" | "registry";
  url?: string;
  text: string;
  breaking: boolean;
};

export type ReleaseNotes = {
  package: string;
  from: string;
  to: string;
  repo?: string;
  versions: string[];
  notes: ReleaseNote[];
  missing: string[];
  migrationGuides: { title: string; url: string }[];
  truncated: boolean;
  errors: string[];
};

type Options = { maxChars?: number; perNoteChars?: number };

const TTL = 6 * 3600_000;
// the releases list endpoint refuses anything past the first 1000
const MAX_PAGES = 10;
// per-tag lookups for versions the list and the changelog didn't cover
const TAG_LOOKUPS = { anonymous: 8, authenticated: 40 };
// a published release can trail its npm publish by a while
const SLACK = 3 * 86400_000;

const cacheRoot = () => path.join(path.dirname(reposCacheDir()), "releases");

const debug = (msg: string) => {
  if (process.env.SAFEBUMP_DEBUG) console.error(`[release-notes] ${msg}`);
};

// --- GitHub ---------------------------------------------------------------

type Release = { tag: string; body: string; url: string; date?: string; prerelease: boolean };

type Gh = {
  repo: RepoInfo;
  dir: string;
  token?: string;
  requests: number;
  cacheHits: number;
  // set once the rate limit is hit; later calls use stale cache or nothing
  limited?: string;
  // the first unexpected response (bad token, private repo)
  problem?: string;
};

type Cached = { at: number; etag?: string; status: number; link?: string; data?: unknown };

type RawRelease = {
  tag_name: string;
  body?: string | null;
  html_url: string;
  published_at?: string | null;
  created_at?: string;
  prerelease: boolean;
  draft: boolean;
};

const slim = (r: RawRelease): Release => ({
  tag: r.tag_name,
  body: r.body ?? "",
  url: r.html_url,
  date: r.published_at ?? r.created_at ?? undefined,
  prerelease: r.prerelease,
});

const cacheFile = (gh: Gh, key: string) => path.join(gh.dir, `${key.replace(/[^\w.@-]/g, "_")}.json`);

const ghGet = async (gh: Gh, key: string, apiPath: string): Promise<Cached | undefined> => {
  const file = cacheFile(gh, key);
  const cached = existsSync(file)
    ? (JSON.parse(await readFile(file, "utf-8").catch(() => "null")) as Cached | null) ?? undefined
    : undefined;
  if (cached && Date.now() - cached.at < TTL) {
    gh.cacheHits++;
    return cached;
  }
  if (gh.limited) return cached;

  gh.requests++;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com${apiPath}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "safebump",
        ...(gh.token ? { authorization: `Bearer ${gh.token}` } : {}),
        ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
      },
    });
  } catch (e) {
    gh.limited = `GitHub API unreachable: ${e instanceof Error ? e.message : String(e)}`;
    return cached;
  }
  if (res.status === 304 && cached) {
    cached.at = Date.now();
    await writeFile(file, JSON.stringify(cached)).catch(() => undefined);
    return cached;
  }
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (res.status === 429 || (res.status === 403 && remaining === "0")) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const when = reset ? ` until ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : "";
    gh.limited = `GitHub API rate limit reached${when}${gh.token ? "" : "; set GITHUB_TOKEN or GH_TOKEN"}.`;
    return cached;
  }
  if (res.status !== 200 && res.status !== 404) {
    gh.problem ??= `GitHub API returned ${res.status} for ${apiPath}${res.status === 401 ? " (check GITHUB_TOKEN)" : ""}.`;
    return cached ?? { at: Date.now(), status: res.status };
  }
  const entry: Cached = {
    at: Date.now(),
    status: res.status,
    etag: res.headers.get("etag") ?? undefined,
    link: res.headers.get("link") ?? undefined,
  };
  if (res.status === 200) {
    const json = (await res.json()) as RawRelease | RawRelease[];
    entry.data = Array.isArray(json) ? json.filter((r) => !r.draft).map(slim) : slim(json);
  }
  // the cache is best-effort: a read-only home still gets notes
  await writeFile(file, JSON.stringify(entry)).catch(() => undefined);
  return entry;
};

const lastPage = (link?: string) => {
  const m = /[?&]page=(\d+)>;\s*rel="last"/.exec(link ?? "");
  return m ? Number(m[1]) : 1;
};

const listPage = async (gh: Gh, page: number) => {
  const r = await ghGet(gh, `list-p${page}`, `/repos/${gh.repo.owner}/${gh.repo.name}/releases?per_page=100&page=${page}`);
  return r?.status === 200 ? { releases: r.data as Release[], last: lastPage(r.link) } : undefined;
};

const oldest = (rs: Release[]) => Math.min(...rs.map((r) => Date.parse(r.date ?? "") || Infinity));

// Newest first, so the window is found by date: binary search for the first
// page reaching back to `to`, then walk until past `from`.
const listReleases = async (gh: Gh, fromDate?: number, toDate?: number) => {
  const first = await listPage(gh, 1);
  if (!first) return [];
  const last = Math.min(first.last, MAX_PAGES);
  const pages = new Map([[1, first.releases]]);
  const get = async (p: number) => {
    if (!pages.has(p)) pages.set(p, (await listPage(gh, p))?.releases ?? []);
    return pages.get(p)!;
  };

  let start = 1;
  if (toDate !== undefined && oldest(first.releases) > toDate + SLACK && last > 1) {
    let lo = 2;
    let hi = last;
    if (oldest(await get(hi)) > toDate + SLACK) return [...pages.values()].flat();
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (oldest(await get(mid)) > toDate + SLACK) lo = mid + 1;
      else hi = mid;
    }
    start = lo;
  }
  for (let p = start; p <= last; p++) {
    const rs = await get(p);
    if (rs.length === 0 || (fromDate !== undefined && oldest(rs) < fromDate - SLACK)) break;
  }
  return [...pages.values()].flat();
};

const releaseByTag = async (gh: Gh, tag: string) => {
  const r = await ghGet(gh, `tag-${tag}`, `/repos/${gh.repo.owner}/${gh.repo.name}/releases/tags/${encodeURIComponent(tag)}`);
  return r?.status === 200 ? (r.data as Release) : undefined;
};

// --- tags -----------------------------------------------------------------

// the same families as upstream.ts's tagTemplates: per-package ones first
const tagNames = (pkg: string, version: string) => {
  const base = pkg.split("/").pop()!;
  const own = [`${pkg}@${version}`, `${pkg}@v${version}`, `${base}@${version}`, `${base}@v${version}`, `${base}-v${version}`, `${base}-${version}`];
  return { own: Array.from(new Set(own)), repo: [`v${version}`, version, `release-${version}`] };
};

// tag -> version, for tags naming this package or the whole repo; a
// package-specific tag wins when both exist for one version
const mapTags = (pkg: string, versions: string[], tags: Iterable<string>) => {
  const have = new Set(tags);
  const out = new Map<string, string>();
  for (const v of versions) {
    const { own, repo } = tagNames(pkg, v);
    const tag = [...own, ...repo].find((t) => have.has(t));
    if (tag) out.set(v, tag);
  }
  return out;
};

// git, not the API: it costs no rate limit and sees every tag
const lsRemoteTags = (url: string) =>
  new Promise<string[]>((resolve, reject) => {
    execFile(
      "git",
      ["ls-remote", "--tags", "--refs", url],
      { timeout: 60_000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout) => {
        if (err) return reject(new Error(`git ls-remote ${url} failed: ${err.message.split("\n")[0]}`));
        resolve(stdout.split("\n").map((l) => l.split("\trefs/tags/")[1]).filter((t): t is string => !!t));
      },
    );
  });

// --- changelog --------------------------------------------------------------

// "## 5.0.0", "## [5.0.0] - 2023-10-17", "# v5.0.0", "### 5.0.0 (2023-…)",
// "## @scope/pkg@5.0.0", "## pkg v5.0.0", "## [v5.0.0](compare-link)"
const VERSION_HEADING =
  /^(#{1,4})\s+(?:<a[^>]*>\s*(?:<\/a>\s*)?)?(?:version\s+|release\s+)?\[?(?:[\w@/.-]*@|[\w@/.-]+\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/i;
const HEADING = /^(#{1,6})\s/;
const DATE = /\b(\d{4}-\d{2}-\d{2})\b/;

type Section = { text: string; date?: string };

// sections end at the next version heading, or any heading at the first
// version heading's level or above
export const parseChangelog = (markdown: string) => {
  const lines = markdown.split(/\r?\n/);
  const sections = new Map<string, Section>();
  let level: number | undefined;
  let current: { version: string; date?: string; lines: string[] } | undefined;
  let fence = false;
  const flush = () => {
    if (current && !sections.has(current.version)) {
      sections.set(current.version, { text: current.lines.join("\n").trim(), date: current.date });
    }
    current = undefined;
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : HEADING.exec(line);
    // conventional-changelog puts patches one level below minors
    const v = h && (level === undefined || h[1]!.length <= level + 1) ? VERSION_HEADING.exec(line) : null;
    if (v && semver.valid(v[2]!)) {
      flush();
      level ??= v[1]!.length;
      current = { version: semver.clean(v[2]!)!, date: DATE.exec(line)?.[1], lines: [] };
      continue;
    }
    if (h && level !== undefined && h[1]!.length <= level) flush();
    current?.lines.push(line);
  }
  flush();
  return sections;
};

const changelogs = (dir: string) =>
  readdirSync(dir)
    .filter((f) => DOC_FILE.test(f) && /\.(md|markdown|txt)$|^[^.]+$/i.test(f) && statSync(path.join(dir, f)).isFile())
    .sort();

// --- text helpers -----------------------------------------------------------

const clean = (s: string) =>
  s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const BREAKING = /breaking|\bremoved\b|\brenamed\b|\bdeprecat/i;

// 0.x minors are majors in semver's eyes
const isMajorStep = (v: string) => {
  const p = semver.parse(v)!;
  return p.major > 0 ? p.minor === 0 && p.patch === 0 : p.patch === 0;
};

const cut = (text: string, max: number, url?: string) => {
  if (text.length <= max) return text;
  const at = text.lastIndexOf("\n", max);
  const head = text.slice(0, at > max * 0.6 ? at : max).trimEnd();
  return `${head}\n\n… [truncated: ${text.length - head.length} more chars${url ? ` at ${url}` : ""}]`;
};

const MD_LINK = /\[([^\]\n]{1,200})\]\(([^)\s]+)\)/g;
const BARE_URL = /https?:\/\/[^\s)<>"'\]`]+/g;
const GUIDE = /migrat|upgrad|breaking[-_ ]?change/i;
const NOT_A_GUIDE = /github\.com\/[^/]+\/[^/]+\/(pull|issues|commit|compare|releases\/tag)\/|shields\.io|badge/i;

// links that look like migration docs; a guide for a major outside the
// upgrade ("migrating-to-v4" on the way to v5) is left out
const findGuides = (text: string, fromMajor: number, toMajor: number, base?: string) => {
  const out: { title: string; url: string }[] = [];
  const consider = (title: string, url: string) => {
    if (NOT_A_GUIDE.test(url)) return;
    const hay = `${title} ${url}`;
    const forTarget = new RegExp(`\\bv?${toMajor}\\b`, "i").test(title) && /guide/i.test(hay);
    if (!GUIDE.test(hay) && !forTarget) return;
    const majors = [...hay.matchAll(/(?:\bv|to[-_ ]v?|version[-_ ])(\d+)\b/gi)].map((m) => Number(m[1]));
    if (majors.length > 0 && !majors.some((m) => m > fromMajor && m <= toMajor)) return;
    if (!/^https?:/.test(url)) {
      if (!base || url.startsWith("#")) return;
      url = `${base}/${url.replace(/^\.\//, "")}`;
    }
    out.push({ title: title.trim(), url: url.replace(/[.,;:]+$/, "") });
  };
  for (const m of text.matchAll(MD_LINK)) consider(m[1]!, m[2]!);
  const linked = text.replace(MD_LINK, " ");
  for (const m of linked.matchAll(BARE_URL)) consider(decodeURIComponent(m[0].split("/").pop() || m[0]), m[0]);
  return out;
};

// --- registry -----------------------------------------------------------------

// the abbreviated packument has no `time`; npm view reads the full one
// through the project's .npmrc and npm's own HTTP cache
const publishTimes = async (projectRoot: string, pkg: string) => {
  const r = await run(`npm view ${JSON.stringify(pkg)} time --json --loglevel=error`, { cwd: projectRoot });
  if (r.code !== 0) throw new Error(`npm view ${pkg} time failed: ${r.stderr.trim().split("\n")[0]}`);
  return JSON.parse(r.stdout) as Record<string, string>;
};

// --- main -------------------------------------------------------------------

const crossed = (all: string[], from: string, to: string) => {
  const stable = all.filter((v) => !semver.prerelease(v) || v === to);
  return stable.filter((v) => semver.gt(v, from) && semver.lte(v, to)).sort(semver.compare);
};

const priority = (n: ReleaseNote) => (isMajorStep(n.version) ? 0 : n.breaking ? 1 : 2);

// Majors, then breaking-looking notes, then the rest claim the budget; within
// a tier the shortest go first and each takes at most an equal share of
// what's left, so one long note can't starve the others. A major is cut,
// never dropped; anything else that can't fit keeps a pointer to its source.
const applyBudget = (notes: ReleaseNote[], maxChars: number, perNote: number) => {
  let truncated = false;
  let left = maxChars;
  for (const tier of [0, 1, 2]) {
    const queue = notes
      .filter((n) => priority(n) === tier)
      .map((n) => ({ n, want: Math.min(n.text.length, isMajorStep(n.version) ? perNote * 2 : perNote) }))
      .sort((a, b) => a.want - b.want || semver.compare(a.n.version, b.n.version));
    queue.forEach(({ n, want }, i) => {
      let room = Math.min(want, Math.floor(left / (queue.length - i)));
      if (tier === 0) room = Math.max(room, Math.min(want, 800));
      if (room < Math.min(want, 200)) {
        n.text = `… [omitted to fit the budget: ${n.text.length} chars${n.url ? ` at ${n.url}` : ""}]`;
        truncated = true;
        return;
      }
      if (n.text.length > room) truncated = true;
      n.text = cut(n.text, room, n.url);
      left = Math.max(0, left - n.text.length);
    });
  }
  return truncated;
};

export const fetchReleaseNotes = async (
  projectRoot: string,
  pkg: string,
  from: string,
  to: string,
  options: Options = {},
): Promise<ReleaseNotes> => {
  const maxChars = options.maxChars ?? 40_000;
  const perNote = options.perNoteChars ?? 4_000;
  const started = Date.now();
  const result: ReleaseNotes = {
    package: pkg,
    from,
    to,
    versions: [],
    notes: [],
    missing: [],
    migrationGuides: [],
    truncated: false,
    errors: [],
  };
  const fail = (e: unknown) => result.errors.push(e instanceof Error ? e.message : String(e));
  if (!semver.valid(from) || !semver.valid(to)) {
    fail(`from and to must be exact versions (got ${from}, ${to}).`);
    return result;
  }

  const [packument, manifest, times, fetched] = await Promise.all([
    getPackument(projectRoot, pkg).catch((e) => void fail(e)),
    getManifest(projectRoot, pkg, to).catch(() => undefined),
    publishTimes(projectRoot, pkg).catch((e) => void fail(e)),
    fetchPackage(projectRoot, pkg, to).catch((e) => void fail(e)),
  ]);
  const all = packument ? Object.keys(packument.versions) : Object.keys(times ?? {}).filter((v) => semver.valid(v));
  const includePre = !!semver.prerelease(to);
  result.versions = crossed(all, from, to);
  const wanted = new Set(result.versions);
  const byVersion = new Map<string, ReleaseNote>();
  const add = (n: ReleaseNote) => {
    if (!wanted.has(n.version) || byVersion.has(n.version) || !n.text) return;
    byVersion.set(n.version, n);
  };
  const breaking = (v: string, text: string) => isMajorStep(v) || BREAKING.test(text);
  const fromMajor = semver.major(from);
  const toMajor = semver.major(to);
  const guideText: { text: string; base?: string }[] = [];

  const repo = parseRepository(manifest?.repository as Parameters<typeof parseRepository>[0]);
  if (repo) result.repo = repo.web;
  else fail(`${pkg}@${to} has no usable "repository" field; only the tarball's changelog is used.`);
  const blobBase = repo?.host === "github.com" ? `${repo.web}/blob/HEAD${repo.directory ? `/${repo.directory}` : ""}` : undefined;

  // 1. GitHub releases in the date window
  let gh: Gh | undefined;
  if (repo?.host === "github.com") {
    const dir = path.join(cacheRoot(), `${repo.owner}__${repo.name}`.replace(/[^\w.-]/g, "_"));
    await mkdir(dir, { recursive: true }).catch(() => undefined);
    gh = { repo, dir, token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined, requests: 0, cacheHits: 0 };
    const date = (v: string) => (times?.[v] ? Date.parse(times[v]!) : undefined);
    const releases = await listReleases(gh, date(from), date(to));
    const tags = mapTags(pkg, result.versions, releases.map((r) => r.tag));
    const byTag = new Map(releases.map((r) => [r.tag, r]));
    for (const [v, tag] of tags) {
      const r = byTag.get(tag)!;
      if (r.prerelease && !includePre) continue;
      const text = clean(r.body);
      add({ version: v, date: times?.[v] ?? r.date, source: "github-release", url: r.url, text, breaking: breaking(v, text) });
      if (text) guideText.push({ text, base: blobBase });
    }
  }

  // 2. the changelog shipped in the target version
  const readTarball = (dir: string, readme: boolean) => {
    for (const file of changelogs(dir)) {
      const text = readFileSync(path.join(dir, file), "utf-8");
      const url = blobBase ? `${blobBase}/${file}` : undefined;
      let used = false;
      for (const [v, s] of parseChangelog(text)) {
        if (!wanted.has(v) || byVersion.has(v)) continue;
        const body = clean(s.text);
        add({ version: v, date: times?.[v] ?? s.date, source: "changelog", url, text: body, breaking: breaking(v, body) });
        if (body) guideText.push({ text: body, base: blobBase });
        used = true;
      }
      // a migration doc in the tarball is readable offline
      if (!used && readme && /migrat|upgrad|breaking/i.test(file)) {
        result.migrationGuides.push({ title: file, url: path.join(dir, file) });
      }
    }
    const file = readme && readdirSync(dir).find((f) => /^readme(\.md|\.markdown)?$/i.test(f));
    if (file) guideText.push({ text: readFileSync(path.join(dir, file), "utf-8"), base: blobBase });
  };
  if (fetched) readTarball(fetched.dir, true);

  // backports to an older line (57.0.6 published after 58.0.0) are absent
  // from the target's changelog but present in their own
  const backport = result.versions.filter((v) => !byVersion.has(v)).pop();
  if (fetched && backport && semver.major(backport) < toMajor) {
    const older = await fetchPackage(projectRoot, pkg, backport).catch((e) => void fail(e));
    if (older) readTarball(older.dir, false);
  }

  // 3. per-tag lookups for the most important versions still missing
  if (gh && !gh.limited) {
    const gaps = result.versions.filter((v) => !byVersion.has(v));
    const important = [...gaps].sort(
      (a, b) =>
        Number(!isMajorStep(a)) - Number(!isMajorStep(b)) ||
        Number(semver.patch(a) !== 0) - Number(semver.patch(b) !== 0) ||
        // backports to the old major matter less than the new line
        Number(semver.major(a) === fromMajor) - Number(semver.major(b) === fromMajor) ||
        semver.compare(a, b),
    );
    const limit = gh.token ? TAG_LOOKUPS.authenticated : TAG_LOOKUPS.anonymous;
    if (important.length > 0) {
      const tagList = await lsRemoteTags(repo!.cloneUrl).catch((e) => void fail(e));
      const tags = tagList ? mapTags(pkg, important, tagList) : new Map<string, string>();
      const picked = important.filter((v) => tags.has(v)).slice(0, limit);
      const found = await Promise.all(picked.map((v) => releaseByTag(gh!, tags.get(v)!)));
      picked.forEach((v, i) => {
        const r = found[i];
        if (!r || (r.prerelease && !includePre)) return;
        const text = clean(r.body);
        add({ version: v, date: times?.[v] ?? r.date, source: "github-release", url: r.url, text, breaking: breaking(v, text) });
        if (text) guideText.push({ text, base: blobBase });
      });
      const unlooked = important.filter((v) => tags.has(v)).length - picked.length;
      if (unlooked > 0) {
        result.errors.push(`${unlooked} more tagged versions not looked up (limit ${limit}${gh.token ? "" : "; set GITHUB_TOKEN for more"}).`);
      }
    }
  }
  for (const e of [gh?.problem, gh?.limited]) if (e) result.errors.push(e);

  // the registry's deprecation message is all some versions have
  for (const v of result.versions) {
    const msg = packument?.versions[v]?.deprecated;
    if (msg) add({ version: v, date: times?.[v], source: "registry", text: `Deprecated: ${msg}`, breaking: true });
  }

  result.notes = [...byVersion.values()].sort((a, b) => semver.compare(a.version, b.version));
  result.missing = result.versions.filter((v) => !byVersion.has(v));

  const seen = new Set(result.migrationGuides.map((g) => g.url));
  for (const { text, base } of guideText) {
    for (const g of findGuides(text, fromMajor, toMajor, base)) {
      if (seen.has(g.url) || result.migrationGuides.length >= 15) continue;
      seen.add(g.url);
      result.migrationGuides.push(g);
    }
  }

  result.truncated = applyBudget(result.notes, maxChars, perNote);
  debug(
    `${pkg}: ${((Date.now() - started) / 1000).toFixed(1)}s, github ${gh?.requests ?? 0} requests / ${gh?.cacheHits ?? 0} cached, ${result.notes.length}/${result.versions.length} versions with notes`,
  );
  return result;
};

// --- output ---------------------------------------------------------------------

const ranges = (vs: string[]) => (vs.length > 30 ? `${vs.slice(0, 30).join(", ")} … (+${vs.length - 30})` : vs.join(", "));

// a note's own headings nest under its "## <version>"
const demote = (text: string) => {
  let fence = false;
  return text
    .split("\n")
    .map((l) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      return !fence && /^#{1,6}\s/.test(l) ? `##${l}`.replace(/^#{7,}/, "######") : l;
    })
    .join("\n");
};

// majors first (they carry the breaking changes), then the rest ascending
export const printReleaseNotes = (r: ReleaseNotes) => {
  console.log(`# ${r.package} ${r.from} → ${r.to}: release notes`);
  const bySource = (s: ReleaseNote["source"]) => r.notes.filter((n) => n.source === s).length;
  console.log(
    `${r.repo ?? "no repository"} · ${r.versions.length} versions crossed · notes for ${r.notes.length} (${bySource("github-release")} GitHub releases, ${bySource("changelog")} changelog)${r.truncated ? " · truncated to fit" : ""}`,
  );
  for (const e of r.errors) console.log(`note: ${e}`);
  if (r.missing.length > 0) console.log(`No notes found for: ${ranges(r.missing)}`);

  if (r.migrationGuides.length > 0) {
    console.log(`\n## Migration guides`);
    for (const g of r.migrationGuides) console.log(`- [${g.title}](${g.url})`);
  }

  const majors = r.notes.filter((n) => isMajorStep(n.version));
  const rest = r.notes.filter((n) => !isMajorStep(n.version));
  for (const n of [...majors, ...rest]) {
    const tags = [n.date?.slice(0, 10), n.source, n.breaking ? "BREAKING?" : undefined].filter(Boolean).join(", ");
    console.log(`\n## ${n.version} (${tags})`);
    if (n.url) console.log(n.url);
    console.log(`\n${demote(n.text)}`);
  }
};
