import { execFile } from "child_process";
import { readdirSync, readFileSync, statSync } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import semver from "semver";
import type { ClassDeclaration, ClassExpression, ParameterDeclaration, SourceFile } from "ts-morph";
import { Node, Project, SyntaxKind, ts } from "ts-morph";

import { fetchPackage } from "./fetch-package";
import { getPackument, resolveVersion } from "./registry";
import { gitIn, resolveCommits, type RepoInfo } from "./upstream";

// Diffs the implementation, not the types, of exactly the APIs a project
// uses between two versions of a package, and flags the behavior changes
// that compile fine and rarely make the release notes: a changed default,
// a new throw, a retry or timeout constant, a dropped branch.
//
// Source comes from the package's repository at the two published commits
// (only the blobs of the package's own source files are fetched into the
// cache repo upstream.ts keeps), or from the published tarballs when the
// repository can't be resolved.

export type ImplFlag = {
  kind:
    | "default-changed"
    | "new-throw"
    | "removed-throw"
    | "constant-changed"
    | "branch-removed"
    | "branch-added"
    | "signature-changed"
    | "deleted"
    | "added";
  detail: string;
  // in the new source
  line?: number;
};

export type ImplDiff = {
  api: string;
  file?: string;
  oldRef: string;
  newRef: string;
  changed: boolean;
  hunks: string;
  flags: ImplFlag[];
  callees: string[];
  url?: string;
  note?: string;
};

export type ImplDiffReport = { package: string; from: string; to: string; repo?: string; diffs: ImplDiff[]; notes: string[] };

type ApiRef = { api: string; owner?: string; member?: string };
type Options = {
  calleeDepth?: number;
  maxHunkLines?: number;
  // "tarball" skips the repository and diffs the published files
  source?: "auto" | "tarball";
};

const MAX_SCOPE_FILES = 4000;
const MAX_PARSE = 60;
const MAX_CALLEES = 10;
const MAX_FILE_BYTES = 1_500_000;

// --- source snapshots -------------------------------------------------------

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const NOT_SOURCE = [
  /\.d\.[cm]?ts$/,
  /\.(test|spec|test-d|bench|stories|e2e)\.[cm]?[jt]sx?$/,
  /(^|\/)(node_modules|__tests__|__mocks__|__fixtures__|tests?|e2e|examples?|docs?|scripts|benchmarks?|fixtures?|ecosystem-tests|coverage)\//,
  /\.min\.js$/,
];
const BUILT = /(^|\/)(dist|build|out|lib-esm|esm|cjs|umd)\//;

const isSource = (p: string) => SOURCE.test(p) && !NOT_SOURCE.some((r) => r.test(p));

type Snapshot = {
  ref: string;
  sha?: string;
  paths: Set<string>;
  read: (paths: string[]) => Promise<Map<string, string>>;
  // directory of another package in the same repo (or fetched alongside)
  workspace: (name: string) => Promise<string | undefined>;
  project: Project;
  parsed: Map<string, SourceFile>;
  // built code only (no src/ anywhere): names may be mangled
  builtOnly?: boolean;
};

const newProject = () =>
  new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve },
  });

// cat-file in buffer mode: sizes are bytes, and string mode would mangle them
const catFile = (dir: string, oids: string[]) =>
  new Promise<Map<string, Buffer | undefined>>((resolve, reject) => {
    const child = execFile(
      "git",
      ["cat-file", "--batch"],
      { cwd: dir, encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } },
      (err, stdout) => {
        if (err) return reject(err);
        const out = new Map<string, Buffer | undefined>();
        let at = 0;
        while (at < stdout.length) {
          const nl = stdout.indexOf(10, at);
          if (nl < 0) break;
          const [oid, type, size] = stdout.subarray(at, nl).toString().split(" ");
          at = nl + 1;
          if (type === "missing" || !size) {
            out.set(oid!, undefined);
            continue;
          }
          const n = Number(size);
          out.set(oid!, stdout.subarray(at, at + n));
          at += n + 1;
        }
        resolve(out);
      },
    );
    child.stdin?.end(oids.join("\n") + "\n");
  });

const repoSnapshot = async (dir: string, sha: string, ref: string): Promise<Snapshot> => {
  const ls = await gitIn(dir, ["-c", "core.quotepath=off", "ls-tree", "-r", "-z", "--format=%(objectname) %(objecttype) %(path)", sha]);
  if (ls.code !== 0) throw new Error(`git ls-tree failed: ${ls.stderr.trim().split("\n").pop()}`);
  const oids = new Map<string, string>();
  for (const entry of ls.stdout.split("\0")) {
    const m = /^([0-9a-f]+) blob (.+)$/.exec(entry);
    if (m) oids.set(m[2]!, m[1]!);
  }
  const cache = new Map<string, string>();
  const read = async (paths: string[]) => {
    const want = Array.from(new Set(paths.filter((p) => !cache.has(p) && oids.has(p))));
    if (want.length > 0) {
      const ids = Array.from(new Set(want.map((p) => oids.get(p)!)));
      let blobs = await catFile(dir, ids);
      const missing = ids.filter((id) => !blobs.get(id));
      // only these blobs, in batches; what lazy fetching would do one by one
      for (let i = 0; i < missing.length; i += 2000) {
        const f = await gitIn(dir, [
          "-c", "fetch.negotiationAlgorithm=noop", "fetch", "-q", "--no-tags", "--no-write-fetch-head",
          "--recurse-submodules=no", "--filter=blob:none", "origin", ...missing.slice(i, i + 2000),
        ]);
        if (f.code !== 0) throw new Error(`git fetch of source blobs failed: ${f.stderr.trim().split("\n").pop()}`);
      }
      if (missing.length > 0) blobs = new Map([...blobs, ...(await catFile(dir, missing))]);
      for (const p of want) {
        const b = blobs.get(oids.get(p)!);
        if (b && b.length <= MAX_FILE_BYTES) cache.set(p, b.toString("utf-8"));
      }
    }
    return new Map(paths.filter((p) => cache.has(p)).map((p) => [p, cache.get(p)!]));
  };
  const snap: Snapshot = {
    ref,
    sha,
    paths: new Set(oids.keys()),
    read,
    workspace: async (name) => {
      // packages/<base> first; every package.json only when that misses
      const base = name.split("/").pop()!;
      const manifests = [...oids.keys()].filter(
        (p) => /(^|\/)package\.json$/.test(p) && !p.includes("node_modules/") && p.split("/").length <= 5,
      );
      const guess = manifests.filter((p) => path.posix.basename(path.posix.dirname(p)) === base);
      for (const batch of [guess, manifests]) {
        for (const [p, text] of await read(batch)) {
          try {
            if ((JSON.parse(text) as { name?: string }).name === name) return path.posix.dirname(p);
          } catch {
            // not JSON (templates)
          }
        }
      }
      return undefined;
    },
    project: newProject(),
    parsed: new Map(),
  };
  return snap;
};

const walk = (dir: string, prefix: string, out: Set<string>) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, `${prefix}${e.name}/`, out);
    else out.add(`${prefix}${e.name}`);
  }
  return out;
};

// the published files; other packages it imports are fetched on demand and
// mounted under ~deps/<name>/ (node_modules/ is skipped as non-source)
const tarballSnapshot = async (projectRoot: string, pkg: string, version: string): Promise<Snapshot> => {
  const fetched = await fetchPackage(projectRoot, pkg, version);
  const mounts = new Map<string, string>([["", fetched.dir]]);
  const paths = walk(fetched.dir, "", new Set());
  const manifest = JSON.parse(readFileSync(path.join(fetched.dir, "package.json"), "utf-8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const toDisk = (p: string) => {
    for (const [prefix, dir] of mounts) {
      if (prefix && p.startsWith(prefix)) return path.join(dir, p.slice(prefix.length));
    }
    return path.join(fetched.dir, p);
  };
  return {
    ref: version,
    paths,
    builtOnly: ![...paths].some((p) => p.startsWith("src/") && isSource(p)),
    read: async (ps) => {
      const out = new Map<string, string>();
      for (const p of ps) {
        try {
          const file = toDisk(p);
          if (paths.has(p) && statSync(file).size <= MAX_FILE_BYTES) out.set(p, readFileSync(file, "utf-8"));
        } catch {
          // unreadable: skip
        }
      }
      return out;
    },
    workspace: async (name) => {
      const prefix = `~deps/${name}/`;
      if (mounts.has(prefix)) return prefix.slice(0, -1);
      const range = manifest.dependencies?.[name] ?? manifest.peerDependencies?.[name];
      if (!range) return undefined;
      const p = await getPackument(projectRoot, name).catch(() => undefined);
      const v = p && resolveVersion(p, range);
      const dep = v && (await fetchPackage(projectRoot, name, v).catch(() => undefined));
      if (!dep) return undefined;
      mounts.set(prefix, dep.dir);
      walk(dep.dir, prefix, paths);
      return prefix.slice(0, -1);
    },
    project: newProject(),
    parsed: new Map(),
  };
};

// a package directory's own source: src/ when it has one (skips committed
// build output), otherwise everything that isn't tests or docs
const scopeFiles = (snap: Snapshot, dir: string) => {
  const under = (p: string) => (dir ? p.startsWith(`${dir}/`) : true);
  const all = [...snap.paths].filter((p) => under(p) && isSource(p));
  const rel = (p: string) => (dir ? p.slice(dir.length + 1) : p);
  const src = all.filter((p) => rel(p).startsWith("src/"));
  if (src.length > 0) return src.slice(0, MAX_SCOPE_FILES);
  const unbuilt = all.filter((p) => !BUILT.test(rel(p)));
  return (unbuilt.length > 0 ? unbuilt : all.filter((p) => !/\.map$/.test(p))).slice(0, MAX_SCOPE_FILES);
};

const parse = (snap: Snapshot, file: string, text: string) => {
  let sf = snap.parsed.get(file);
  if (!sf) {
    sf = snap.project.createSourceFile(`/${file.replace(/\.[cm]([jt]s)$/, ".$1")}`, text, { overwrite: true });
    snap.parsed.set(file, sf);
  }
  return sf;
};

// --- locating declarations -----------------------------------------------------------

type Target = {
  // the container (class or object) for a member; undefined for a top-level name
  owner?: string;
  name: string;
  // where the reference was resolved from: searched first
  files?: string[];
  // searched next
  dirs: string[];
  // a bare import: another package of the repo
  spec?: string;
  // this.x() may be inherited
  base?: string;
};

type Impl = {
  label: string;
  file: string;
  sf: SourceFile;
  nodes: Node[];
  text: string;
  start: number;
  end: number;
  signature: string;
  // the class a method belongs to, for this.x() callees
  className?: string;
  baseName?: string;
  // class APIs: method name -> normalized text, to list changed methods
  methods?: Map<string, string>;
  snap?: Snapshot;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isClass = (n: Node | undefined): n is ClassDeclaration | ClassExpression =>
  !!n && (Node.isClassDeclaration(n) || Node.isClassExpression(n));

const isTopLevel = (n: Node) =>
  !n.getFirstAncestor(
    (a) => Node.isFunctionLikeDeclaration(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a) || isClass(a),
  );

const unwrap = (n: Node | undefined): Node | undefined => {
  while (n && (Node.isAsExpression(n) || Node.isSatisfiesExpression(n) || Node.isParenthesizedExpression(n) || Node.isTypeAssertion(n))) {
    n = n.getExpression();
  }
  return n;
};

// declarations of `name` in one file: classes, functions, consts
const declarationsIn = (sf: SourceFile, name: string): Node[] => {
  const out: Node[] = [];
  for (const c of sf.getDescendantsOfKind(SyntaxKind.ClassDeclaration)) if (c.getName() === name && isTopLevel(c)) out.push(c);
  for (const f of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    if (f.getName() === name && isTopLevel(f) && f.hasBody()) out.push(f);
  }
  for (const v of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (v.getName() === name && isTopLevel(v) && v.getInitializer()) out.push(v);
  }
  // `exports.name = …` / `X.name = function` in CommonJS builds
  for (const b of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const left = b.getLeft();
    if (b.getOperatorToken().getKind() === SyntaxKind.EqualsToken && Node.isPropertyAccessExpression(left) &&
        left.getName() === name && /^(module\.)?exports$/.test(left.getExpression().getText()) && isTopLevel(b)) {
      const right = unwrap(b.getRight());
      if (right && (Node.isFunctionExpression(right) || Node.isArrowFunction(right) || Node.isClassExpression(right))) out.push(b);
    }
  }
  return out;
};

// the class or object literal a declaration stands for
const containerOf = (decl: Node) => {
  if (Node.isClassDeclaration(decl)) return decl;
  const init = Node.isVariableDeclaration(decl) ? unwrap(decl.getInitializer()) : Node.isBinaryExpression(decl) ? unwrap(decl.getRight()) : undefined;
  if (init && (Node.isClassExpression(init) || Node.isObjectLiteralExpression(init))) return init;
  return undefined;
};

const memberOf = (container: Node, member: string): Node | undefined => {
  if (isClass(container)) {
    if (member === "constructor") return container.getConstructors().find((c) => c.hasBody());
    const m = container.getMembers().find(
      (x) => (Node.isMethodDeclaration(x) || Node.isPropertyDeclaration(x) || Node.isGetAccessorDeclaration(x)) &&
        x.getName() === member && !(Node.isMethodDeclaration(x) && !x.hasBody()),
    );
    return m;
  }
  if (Node.isObjectLiteralExpression(container)) {
    return container.getProperties().find(
      (p) => (Node.isPropertyAssignment(p) || Node.isMethodDeclaration(p) || Node.isShorthandPropertyAssignment(p)) && p.getName() === member,
    );
  }
  return undefined;
};

const baseNameOf = (container: Node) =>
  isClass(container) ? container.getExtends()?.getExpression().getText() : undefined;

// `export { a as name } from "./x"`, `export * from "pkg"`: where else to look
const reexportsOf = (sf: SourceFile, name: string) => {
  const out: { spec: string; name: string }[] = [];
  for (const e of sf.getExportDeclarations()) {
    const spec = e.getModuleSpecifierValue();
    if (!spec) continue;
    if (e.isNamespaceExport() && !e.getNamespaceExport()) out.push({ spec, name });
    for (const s of e.getNamedExports()) {
      if ((s.getAliasNode()?.getText() ?? s.getName()) === name) out.push({ spec, name: s.getName() });
    }
  }
  // import { a as name } from "pkg"; export { name }
  for (const i of sf.getImportDeclarations()) {
    for (const s of i.getNamedImports()) {
      if ((s.getAliasNode()?.getText() ?? s.getName()) === name) out.push({ spec: i.getModuleSpecifierValue(), name: s.getName() });
    }
  }
  return out;
};

const EXTS = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"];

const resolveRelative = (snap: Snapshot, from: string, spec: string) => {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const stems = [base, base.replace(/\.[cm]?js$/, ""), base.replace(/\.jsx$/, "")];
  for (const stem of stems) for (const ext of EXTS) if (snap.paths.has(stem + ext) && SOURCE.test(stem + ext)) return stem + ext;
  return undefined;
};

const textHas = (text: string, name: string) => new RegExp(`(^|[^\\w$])${escapeRe(name)}($|[^\\w$])`).test(text);

// path closeness to the name: useQuery.ts beats queries/index.ts
const pathRank = (file: string, name: string) => {
  const stem = path.posix.basename(file).replace(/\.[^.]+$/, "").toLowerCase();
  const n = name.toLowerCase();
  return (stem === n ? 0 : stem.includes(n) || n.includes(stem) ? 1 : 2) * 100 + file.split("/").length;
};

type Found = { file: string; sf: SourceFile; decl: Node; node: Node; container?: Node };

const findIn = async (snap: Snapshot, files: string[], t: Target): Promise<Found | undefined> => {
  const key = t.owner ?? t.name;
  const texts = await snap.read(files);
  const hits = [...texts].filter(([, text]) => textHas(text, key) && (!t.owner || textHas(text, t.name)));
  hits.sort((a, b) => pathRank(a[0], key) - pathRank(b[0], key) || a[0].localeCompare(b[0]));
  const found: (Found & { score: number })[] = [];
  for (const [file, text] of hits.slice(0, MAX_PARSE)) {
    const sf = parse(snap, file, text);
    for (const decl of declarationsIn(sf, key)) {
      if (!t.owner) {
        found.push({ file, sf, decl, node: decl, container: containerOf(decl), score: pathRank(file, key) });
        continue;
      }
      const container = containerOf(decl);
      const node = container && memberOf(container, t.name);
      if (node) found.push({ file, sf, decl, node, container, score: pathRank(file, key) });
    }
  }
  // functions and classes over consts that merely alias them
  const weight = (f: Found) => (Node.isVariableDeclaration(f.decl) && !containerOf(f.decl) && !isFunctionInit(f.decl) ? 1000 : 0);
  found.sort((a, b) => a.score + weight(a) - (b.score + weight(b)) || a.file.localeCompare(b.file));
  return found[0];
};

const isFunctionInit = (v: Node) => {
  const init = Node.isVariableDeclaration(v) ? unwrap(v.getInitializer()) : undefined;
  return !!init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init) || Node.isCallExpression(init));
};

// files first, then each directory's source, then re-exports out of them
// (another file under an alias, or another package of the same repo)
const locate = async (snap: Snapshot, t: Target, depth = 0, seen = new Set<string>()): Promise<Found | undefined> => {
  const k = `${t.owner ?? ""}.${t.name}@${t.dirs.join(",")}`;
  if (depth > 4 || seen.has(k)) return undefined;
  seen.add(k);
  if (t.files?.length) {
    const hit = await findIn(snap, t.files, t);
    if (hit) return hit;
  }
  for (const dir of t.dirs) {
    const files = scopeFiles(snap, dir);
    const hit = await findIn(snap, files, t);
    if (hit) return hit;
    // follow re-exports of the owner (or the name) out of this package
    const key = t.owner ?? t.name;
    const texts = await snap.read(files);
    const ordered = [...texts].filter(([, s]) => /\bexport\b/.test(s) && (textHas(s, key) || /export\s*\*\s*from/.test(s)))
      .sort((a, b) => Number(!/(^|\/)index\.[^/]+$/.test(a[0])) - Number(!/(^|\/)index\.[^/]+$/.test(b[0])) || a[0].split("/").length - b[0].split("/").length);
    for (const [file, text] of ordered.slice(0, MAX_PARSE)) {
      const sf = parse(snap, file, text);
      for (const r of reexportsOf(sf, key)) {
        const next = (n: string): Target => (t.owner ? { owner: n, name: t.name, dirs: [] } : { name: n, dirs: [] });
        if (r.spec.startsWith(".")) {
          const target = resolveRelative(snap, file, r.spec);
          if (r.name === key && !target) continue;
          const hit = await locate(snap, { ...next(r.name), files: target ? [target] : undefined, dirs: [dir] }, depth + 1, seen);
          if (hit) return hit;
        } else {
          const pkgName = r.spec.startsWith("@") ? r.spec.split("/").slice(0, 2).join("/") : r.spec.split("/")[0]!;
          const ws = await snap.workspace(pkgName);
          if (ws === undefined) continue;
          const hit = await locate(snap, { ...next(r.name), dirs: [ws] }, depth + 1, seen);
          if (hit) return hit;
        }
      }
    }
  }
  return undefined;
};

// --- implementation text ---------------------------------------------------------------

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// names, optionality and types; defaults are flagged on their own
const paramText = (p: ParameterDeclaration) => {
  const name = p.getNameNode();
  const shown = Node.isIdentifier(name)
    ? name.getText()
    : Node.isObjectBindingPattern(name)
      ? `{ ${name.getElements().map((e) => e.getPropertyNameNode()?.getText() ?? e.getName()).join(", ")} }`
      : "[…]";
  const type = p.getTypeNode()?.getText();
  return squash(`${p.isRestParameter() ? "..." : ""}${shown}${p.hasQuestionToken() || p.hasInitializer() ? "?" : ""}${type ? `: ${type}` : ""}`);
};

const signatureOf = (n: Node): string => {
  const fn = functionOf(n);
  if (fn) {
    const params = fn.getParameters().map(paramText).join(", ");
    const ret = fn.getReturnTypeNode()?.getText();
    return `(${params})${ret ? `: ${squash(ret)}` : ""}`;
  }
  if (isClass(n)) {
    const c = n.getConstructors().find((x) => x.hasBody()) ?? n.getConstructors()[0];
    return c ? `constructor(${c.getParameters().map(paramText).join(", ")})` : "";
  }
  return "";
};

const functionOf = (n: Node) => {
  if (Node.isFunctionDeclaration(n) || Node.isMethodDeclaration(n) || Node.isConstructorDeclaration(n) || Node.isGetAccessorDeclaration(n)) return n;
  const init = Node.isVariableDeclaration(n) || Node.isPropertyDeclaration(n) || Node.isPropertyAssignment(n)
    ? unwrap(n.getInitializer())
    : Node.isBinaryExpression(n) ? unwrap(n.getRight()) : undefined;
  return init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) ? init : undefined;
};

// the statement around a const, so `export const x = …` reads whole
const outer = (n: Node) => (Node.isVariableDeclaration(n) ? n.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? n : n);

const toImpl = (f: Found, label: string): Impl => {
  const base = {
    label,
    file: f.file,
    sf: f.sf,
    className: f.container && isClass(f.container) ? (f.container.getName() ?? (Node.isVariableDeclaration(f.decl) ? f.decl.getName() : undefined)) : undefined,
    baseName: f.container ? baseNameOf(f.container) : undefined,
  };
  // a class on its own: what construction does (constructor, field
  // initializers, statics), plus which methods changed
  if (f.node === f.decl && f.container && isClass(f.container)) {
    const cls = f.container;
    const nodes = cls.getMembers().filter(
      (m) => (Node.isConstructorDeclaration(m) && m.hasBody()) || (Node.isPropertyDeclaration(m) && !!m.getInitializer()),
    );
    const heading = squash(cls.getText().slice(0, cls.getText().indexOf("{") + 1));
    const methods = new Map<string, string>();
    for (const m of cls.getMembers()) {
      if ((Node.isMethodDeclaration(m) || Node.isGetAccessorDeclaration(m) || Node.isSetAccessorDeclaration(m)) && m.getBody?.()) {
        methods.set(`${m.isStatic() ? "static " : ""}${m.getName()}`, tokens(m.getText()));
      }
    }
    return {
      ...base,
      className: cls.getName() ?? base.className,
      nodes,
      text: [heading, ...nodes.map((n) => indent(linesOf(n), "  ")), "}"].join("\n"),
      start: cls.getStartLineNumber(),
      end: cls.getEndLineNumber(),
      signature: `${heading.replace(/\{$/, "").trim()} ${signatureOf(cls)}`.trim(),
      methods,
    };
  }
  const node = outer(f.node);
  return {
    ...base,
    nodes: [f.node],
    text: linesOf(node),
    start: node.getStartLineNumber(),
    end: node.getEndLineNumber(),
    signature: signatureOf(f.node),
  };
};

// whole source lines (with the doc comment), dedented
const linesOf = (n: Node) => {
  const text = n.getSourceFile().getFullText();
  const start = text.lastIndexOf("\n", n.getStart(true) - 1) + 1;
  const lines = text.slice(start, n.getEnd()).split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
  const cut = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut)).join("\n");
};

const indent = (s: string, by: string) => s.split("\n").map((l) => (l ? by + l : l)).join("\n");

// token stream without comments, semicolons and trailing commas: a
// reformat or a reworded comment isn't a change
const tokens = (text: string) => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const out: string[] = [];
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
    if (k === ts.SyntaxKind.SemicolonToken) continue;
    out.push(scanner.getTokenText());
  }
  return out.filter((t, i) => !(t === "," && /^[)\]}>]$/.test(out[i + 1] ?? ""))).join(" ");
};

// --- facts for flags -------------------------------------------------------------------

type Fact = { key: string; value: string; line: number };
type Facts = {
  defaults: Fact[];
  constants: Fact[];
  throws: Fact[];
  branches: Fact[];
};

const LITERAL_KINDS = new Set([
  SyntaxKind.StringLiteral, SyntaxKind.NumericLiteral, SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TrueKeyword, SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword, SyntaxKind.BigIntLiteral,
]);

const isLiteral = (n: Node | undefined): boolean => {
  n = unwrap(n);
  if (!n) return false;
  if (LITERAL_KINDS.has(n.getKind())) return true;
  if (Node.isPrefixUnaryExpression(n)) return isLiteral(n.getOperand());
  // 10 * 60 * 1000
  if (Node.isBinaryExpression(n)) return isLiteral(n.getLeft()) && isLiteral(n.getRight()) && n.getLeft().getKind() !== SyntaxKind.StringLiteral;
  if (Node.isArrayLiteralExpression(n)) return n.getElements().every(isLiteral) && n.getText().length <= 200;
  if (Node.isObjectLiteralExpression(n)) {
    return n.getText().length <= 200 && n.getProperties().every((p) => Node.isPropertyAssignment(p) && isLiteral(p.getInitializer()));
  }
  return false;
};

const LOGGING = /(^|\.)(console|log|logger|debug|warn|info|trace|loggerFor)(\.|$)|^(debug|warn|log|invariant)$/i;

// where a literal sits: "timeout", "post(#0)", "retries <", "request.headers.X-Foo"
const keyOf = (n: Node, depth = 0): string | undefined => {
  const p = n.getParent();
  if (!p || depth > 4) return undefined;
  if (Node.isParenthesizedExpression(p) || Node.isAsExpression(p) || Node.isSatisfiesExpression(p) || Node.isPrefixUnaryExpression(p)) return keyOf(p, depth);
  if (Node.isBinaryExpression(p) && isLiteral(p)) return keyOf(p, depth);
  if (Node.isPropertyAssignment(p) && p.getInitializer() === n) {
    const name = p.getName();
    const obj = p.getParent();
    const up = obj && keyOf(obj, depth + 1);
    return up ? `${up}.${name}` : name;
  }
  if (Node.isArrayLiteralExpression(p)) return keyOf(p, depth + 1) ?? undefined;
  if (Node.isVariableDeclaration(p) || Node.isPropertyDeclaration(p)) return p.getName();
  if (Node.isReturnStatement(p)) return "return";
  if (Node.isConditionalExpression(p) && p.getCondition() !== n) {
    return `${clip(squash(p.getCondition().getText()), 80)} ${p.getWhenTrue() === n ? "?" : ":"}`;
  }
  if (Node.isCallExpression(p) || Node.isNewExpression(p)) {
    const callee = squash(p.getExpression().getText());
    if (LOGGING.test(callee)) return undefined;
    const i = (p.getArguments() as Node[]).indexOf(n);
    return i >= 0 ? `${clip(callee, 60)}(#${i})` : undefined;
  }
  if (Node.isBinaryExpression(p)) {
    const op = p.getOperatorToken().getText();
    const other = p.getLeft() === n ? p.getRight() : p.getLeft();
    if (op === "??" || op === "||") return undefined; // a default
    if (/^[=!<>]=?=?$|^[+\-*/]=?$/.test(op)) return `${clip(squash(other.getText()), 60)} ${op}`;
  }
  return undefined;
};

// the parent, past parentheses and casts
const unwrapUp = (n: Node) => {
  let p = n.getParent();
  while (p && (Node.isParenthesizedExpression(p) || Node.isAsExpression(p) || Node.isSatisfiesExpression(p))) p = p.getParent();
  return p;
};

// { backoff: 500, ...options }: a property a later spread can override
const isSpreadDefault = (p: Node) => {
  const obj = p.getParent();
  if (!(Node.isPropertyAssignment(p) || Node.isMethodDeclaration(p)) || !obj || !Node.isObjectLiteralExpression(obj)) return false;
  const props = obj.getProperties();
  return props.slice(props.indexOf(p as never) + 1).some((x) => Node.isSpreadAssignment(x));
};

// `x.y || new Thing()`, not `a !== b || c`: a value with a fallback
const isFallbackShaped = (n: Node) => {
  if (!Node.isBinaryExpression(n) || n.getRight().getText().length > 100) return false;
  const left = unwrap(n.getLeft())!;
  if (Node.isBinaryExpression(left) || Node.isPrefixUnaryExpression(left)) return false;
  return Node.isIdentifier(left) || Node.isPropertyAccessExpression(left) || Node.isElementAccessExpression(left) || Node.isCallExpression(left);
};

// a || b in an if/while/ternary test is logic, not a fallback
const isTest = (a: Node) => {
  const p = a.getParent();
  if (!p) return false;
  if (Node.isIfStatement(p) || Node.isWhileStatement(p) || Node.isDoStatement(p)) return p.getExpression() === a;
  return Node.isConditionalExpression(p) && p.getCondition() === a;
};
const inCondition = (n: Node) => isTest(n) || inside(n, isTest) || Node.isPrefixUnaryExpression(n.getParent()!);

const inside = (n: Node, pred: (a: Node) => boolean) => !!n.getFirstAncestor(pred);

// a top-level const, a static field, or a property of a const object
// literal, in this file or one imported relatively
type ConstLookup = (sf: SourceFile, ref: string) => string | undefined;

const constLookup = (snap: Snapshot, files: Map<string, string>): ConstLookup => {
  const fileOf = new Map<SourceFile, string>();
  for (const [p, sf] of snap.parsed) fileOf.set(sf, p);
  const lookup: ConstLookup = (sf, ref) => {
    const [head, prop] = ref.split(".");
    const decl = sf.getVariableDeclaration(head!) ?? sf.getClass(head!);
    if (decl) {
      if (Node.isVariableDeclaration(decl)) {
        const init = unwrap(decl.getInitializer());
        if (!decl.getVariableStatement()?.getDeclarationKind().startsWith("const")) return undefined;
        if (!prop) return isLiteral(init) ? squash(init!.getText()) : undefined;
        if (init && Node.isObjectLiteralExpression(init)) {
          const p = init.getProperty(prop);
          const v = p && Node.isPropertyAssignment(p) ? unwrap(p.getInitializer()) : undefined;
          return isLiteral(v) ? squash(v!.getText()) : undefined;
        }
        return undefined;
      }
      if (!prop) return undefined;
      const field = decl.getStaticProperty(prop);
      const v = field && Node.isPropertyDeclaration(field) ? unwrap(field.getInitializer()) : undefined;
      return isLiteral(v) ? squash(v!.getText()) : undefined;
    }
    // imported from a sibling file: one hop, already-read files only
    for (const i of sf.getImportDeclarations()) {
      const spec = i.getModuleSpecifierValue();
      if (!spec.startsWith(".")) continue;
      const s = i.getNamedImports().find((x) => (x.getAliasNode()?.getText() ?? x.getName()) === head);
      if (!s) continue;
      const from = fileOf.get(sf);
      const target = from && resolveRelative(snap, from, spec);
      const text = target && files.get(target);
      if (!target || text === undefined) return undefined;
      const other = parse(snap, target, text);
      if (other === sf) return undefined;
      return lookup(other, [s.getName(), prop].filter(Boolean).join("."));
    }
    return undefined;
  };
  return lookup;
};

const factsOf = (impl: Impl, lookup: ConstLookup): Facts => {
  const facts: Facts = { defaults: [], constants: [], throws: [], branches: [] };
  const all = impl.nodes.flatMap((n) => [n, ...n.getDescendants()]);
  const add = (list: Fact[], key: string, value: string, n: Node) => list.push({ key, value: clip(squash(value), 160), line: n.getStartLineNumber() });
  const isDefaultSlot = (n: Node) => {
    const p = n.getParent();
    if (!p) return false;
    if ((Node.isParameterDeclaration(p) || Node.isBindingElement(p)) && p.getInitializer() === n) return true;
    if (Node.isBinaryExpression(p) && ["??", "||", "??=", "||="].includes(p.getOperatorToken().getText()) && p.getRight() === n) return true;
    return false;
  };
  const seenRefs = new Set<string>();

  for (const n of all) {
    if (Node.isParameterDeclaration(n) || Node.isBindingElement(n)) {
      const init = n.getInitializer();
      if (!init) continue;
      // a destructured parameter's own `= {}` says little; its elements are keyed below
      const nameNode = n.getNameNode();
      if (Node.isParameterDeclaration(n) && !Node.isIdentifier(nameNode)) {
        if (isLiteral(init) && /^[{[]\s*[\]}]$/.test(init.getText())) continue;
      }
      const name = Node.isBindingElement(n)
        ? (n.getPropertyNameNode()?.getText() ?? n.getName())
        : Node.isIdentifier(nameNode) ? nameNode.getText() : `param #${n.getChildIndex()}`;
      add(facts.defaults, `${name} =`, init.getText(), n);
    } else if (Node.isBinaryExpression(n)) {
      const op = n.getOperatorToken().getText();
      const right = unwrap(n.getRight())!;
      const parent = unwrapUp(n);
      // a ?? b ?? c: one default keyed by its first operand
      if (op === "??" && parent && Node.isBinaryExpression(parent) && parent.getOperatorToken().getText() === "??" && unwrap(parent.getLeft()) === n) continue;
      if ((op === "??" || op === "??=") && right.getText().length <= 100) {
        let first: Node = n;
        while (Node.isBinaryExpression(first) && first.getOperatorToken().getText() === "??") first = unwrap(first.getLeft())!;
        const rest = n.getText().slice(first.getEnd() - n.getStart()).replace(/^\s*\)*\s*\?\?\s*/, "");
        add(facts.defaults, `${clip(squash(first.getText()), 80)} ${op}`, rest, n);
      } else if ((op === "||" || op === "||=") && (isLiteral(right) || (isFallbackShaped(n) && !inCondition(n)))) {
        add(facts.defaults, `${clip(squash(n.getLeft().getText()), 80)} ${op}`, n.getRight().getText(), n);
      }
    } else if (Node.isObjectLiteralExpression(n)) {
      // { stream: false, ...options }: what precedes a spread is a default
      const props = n.getProperties();
      const lastSpread = props.map((p) => Node.isSpreadAssignment(p)).lastIndexOf(true);
      for (const p of props.slice(0, Math.max(0, lastSpread))) {
        const value = Node.isPropertyAssignment(p) ? p.getInitializer()!.getText()
          : Node.isMethodDeclaration(p) ? `function ${squash(p.getText()).slice(p.getName().length)}`
          : undefined;
        if (value === undefined || !(Node.isPropertyAssignment(p) || Node.isMethodDeclaration(p))) continue;
        add(facts.defaults, `{ ${p.getName()}: …, ...${clip(squash((props[lastSpread] as Node).getText().slice(3)), 40)} }`, value, p);
      }
    } else if (Node.isThrowStatement(n)) {
      const e = unwrap(n.getExpression());
      const kind = e && Node.isNewExpression(e) ? e.getExpression().getText() : "throw";
      add(facts.throws, kind, n.getText(), n);
    } else if (Node.isIfStatement(n)) {
      add(facts.branches, "if", `if (${squash(n.getExpression().getText())})`, n);
    } else if (Node.isCaseClause(n)) {
      add(facts.branches, "case", `case ${squash(n.getExpression().getText())}`, n);
    } else if (LITERAL_KINDS.has(n.getKind()) || (Node.isPrefixUnaryExpression(n) && isLiteral(n))) {
      if (n.getKind() === SyntaxKind.NullKeyword || [SyntaxKind.TrueKeyword, SyntaxKind.FalseKeyword].includes(n.getKind())) {
        // booleans only where they're named (flags in option objects)
        if (!Node.isPropertyAssignment(n.getParent()) && !Node.isPropertyDeclaration(n.getParent())) continue;
      }
      if (isDefaultSlot(n) || inside(n, (a) => Node.isThrowStatement(a) || Node.isTypeNode(a) || Node.isImportDeclaration(a) || Node.isExportDeclaration(a))) continue;
      if (inside(n, (a) => Node.isParameterDeclaration(a) || Node.isBindingElement(a) || isSpreadDefault(a))) continue;
      if (inside(n, (a) => isDefaultSlot(a))) continue;
      const parent = n.getParent();
      if (parent && Node.isPrefixUnaryExpression(parent)) continue; // counted as the whole -1
      if (parent && Node.isBinaryExpression(parent) && isLiteral(parent)) continue; // counted as 10 * 1000
      const key = keyOf(n);
      if (key) add(facts.constants, key, n.getText(), n);
    } else if (Node.isIdentifier(n) || Node.isPropertyAccessExpression(n)) {
      // references to named constants: DEFAULT_TIMEOUT, OpenAI.DEFAULT_TIMEOUT
      const p = n.getParent();
      if (Node.isPropertyAccessExpression(p) && p.getNameNode() === n) continue;
      if (Node.isIdentifier(n) && Node.isPropertyAccessExpression(p) && p.getExpression() === n) continue;
      if (Node.isPropertyAccessExpression(n) && !Node.isIdentifier(n.getExpression())) continue;
      if (p && (Node.isPropertyAssignment(p) && p.getNameNode() === n)) continue;
      const ref = n.getText();
      if (seenRefs.has(ref) || !/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/.test(ref)) continue;
      seenRefs.add(ref);
      const value = lookup(impl.sf, ref);
      if (value !== undefined) add(facts.constants, ref, value, n);
    }
  }
  return facts;
};

// --- flags ---------------------------------------------------------------------------------

// equal up to parentheses and trailing commas: prettier adds and drops both
const norm = (s: string) => s.replace(/[()]/g, "").replace(/,\s*([\]}])/g, "$1").replace(/\s+/g, " ").trim();

// by normalized key; each group keeps its facts' own key text for display
const group = (facts: Fact[]) => {
  const m = new Map<string, Fact[]>();
  for (const f of facts) m.set(norm(f.key), [...(m.get(norm(f.key)) ?? []), f]);
  return m;
};

const multisetMinus = (a: Fact[], b: Fact[]) => {
  const left = [...b.map((f) => norm(f.value))];
  return a.filter((f) => {
    const i = left.indexOf(norm(f.value));
    if (i >= 0) left.splice(i, 1);
    return i < 0;
  });
};

const defaultDetail = (key: string, v: string) => (key.endsWith(" =") ? `\`${key} ${v}\`` : key.startsWith("{") ? `\`${key.replace("…", v)}\`` : `\`${key} ${v}\``);

const flagsFor = (oldF: Facts, newF: Facts, oldImpl: Impl, newImpl: Impl): ImplFlag[] => {
  const flags: ImplFlag[] = [];
  if (squash(oldImpl.signature) !== squash(newImpl.signature)) {
    flags.push({ kind: "signature-changed", detail: `\`${clip(oldImpl.signature, 200)}\` → \`${clip(newImpl.signature, 200)}\``, line: newImpl.start });
  }

  const od = group(oldF.defaults);
  const nd = group(newF.defaults);
  for (const [k, olds] of od) {
    const key = olds[0]!.key;
    const news = nd.get(k);
    if (!news) {
      flags.push({ kind: "default-changed", detail: `${defaultDetail(key, olds[0]!.value)} removed` });
      continue;
    }
    const gone = multisetMinus(olds, news);
    const fresh = multisetMinus(news, olds);
    for (let i = 0; i < Math.max(gone.length, fresh.length); i++) {
      const o = gone[i];
      const n = fresh[i];
      if (o && n) flags.push({ kind: "default-changed", detail: `${defaultDetail(key, o.value)} → ${defaultDetail(key, n.value)}`, line: n.line });
      else if (o) flags.push({ kind: "default-changed", detail: `${defaultDetail(key, o.value)} removed` });
      else if (n) flags.push({ kind: "default-changed", detail: `${defaultDetail(key, n.value)} added`, line: n.line });
    }
  }
  for (const [k, news] of nd) {
    const key = news[0]!.key;
    // a new fallback for something that was there before reads as a new default
    if (!od.has(k) && !key.endsWith(" =")) {
      flags.push({ kind: "default-changed", detail: `${defaultDetail(key, news[0]!.value)} added`, line: news[0]!.line });
    }
  }

  const oc = group(oldF.constants);
  const nc = group(newF.constants);
  for (const [k, olds] of oc) {
    const key = olds[0]!.key;
    const news = nc.get(k);
    if (!news) continue; // the code using it changed; the hunk shows that
    const gone = multisetMinus(olds, news);
    const fresh = multisetMinus(news, olds);
    if (gone.length === 0 && fresh.length === 0) continue;
    const show = (fs: Fact[]) => fs.map((f) => f.value).join(", ") || "—";
    flags.push({ kind: "constant-changed", detail: `${key} ${show(gone)} → ${show(fresh)}`, line: fresh[0]?.line ?? news[0]!.line });
  }

  const goneThrows = multisetMinus(oldF.throws, newF.throws);
  const newThrows = multisetMinus(newF.throws, oldF.throws);
  for (const n of newThrows) {
    // same error class, reworded: one flag
    const i = goneThrows.findIndex((o) => o.key === n.key && n.key !== "throw");
    const was = i >= 0 ? goneThrows.splice(i, 1)[0] : undefined;
    flags.push({ kind: "new-throw", detail: was ? `\`${n.value}\` (was \`${was.value}\`)` : `\`${n.value}\``, line: n.line });
  }
  for (const o of goneThrows) flags.push({ kind: "removed-throw", detail: `\`${o.value}\`` });

  for (const o of multisetMinus(oldF.branches, newF.branches)) flags.push({ kind: "branch-removed", detail: `\`${o.value}\`` });
  for (const n of multisetMinus(newF.branches, oldF.branches)) flags.push({ kind: "branch-added", detail: `\`${n.value}\``, line: n.line });
  return flags;
};

// --- callees -------------------------------------------------------------------------------

// names every runtime object has; resolving them by name finds unrelated code
const COMMON = new Set([
  "then", "catch", "finally", "push", "map", "filter", "forEach", "reduce", "some", "every", "find", "includes", "indexOf",
  "join", "split", "slice", "splice", "concat", "keys", "values", "entries", "get", "set", "has", "delete", "add", "clear",
  "toString", "valueOf", "call", "apply", "bind", "resolve", "reject", "all", "assign", "freeze", "stringify", "parse",
  "replace", "trim", "startsWith", "endsWith", "toLowerCase", "toUpperCase", "sort", "next", "emit", "on", "off", "once",
  "length", "max", "min", "floor", "ceil", "round", "random", "now", "isArray", "from", "of", "error", "warn", "log", "info", "debug",
]);

const calleeTargets = (impl: Impl, dirs: string[]) => {
  const out = new Map<string, Target>();
  const imports = new Map<string, { spec: string; name: string }>();
  for (const i of impl.sf.getImportDeclarations()) {
    const spec = i.getModuleSpecifierValue();
    for (const s of i.getNamedImports()) imports.set(s.getAliasNode()?.getText() ?? s.getName(), { spec, name: s.getName() });
    const d = i.getDefaultImport();
    if (d) imports.set(d.getText(), { spec, name: "default" });
  }
  const sameFile = new Set(impl.sf.getStatements().flatMap((s) => {
    if (Node.isFunctionDeclaration(s) || Node.isClassDeclaration(s)) return [s.getName() ?? ""];
    if (Node.isVariableStatement(s)) return s.getDeclarations().map((d) => d.getName());
    return [];
  }));
  const fromImport = (local: string): Partial<Target> | undefined => {
    const imp = imports.get(local);
    if (!imp || imp.name === "default") return undefined;
    if (imp.spec.startsWith(".")) {
      const f = resolveRelativeFrom(impl, imp.spec);
      return { name: imp.name, files: f ? [f] : undefined };
    }
    return { name: imp.name, spec: imp.spec };
  };

  for (const node of impl.nodes) {
    for (const call of [...node.getDescendantsOfKind(SyntaxKind.CallExpression), ...node.getDescendantsOfKind(SyntaxKind.NewExpression)]) {
      const e = call.getExpression();
      let t: Target | undefined;
      if (Node.isIdentifier(e)) {
        const name = e.getText();
        if (sameFile.has(name)) t = { name, files: [impl.file], dirs };
        else {
          const imp = fromImport(name);
          if (imp) t = { ...(imp as Target), dirs };
        }
      } else if (Node.isPropertyAccessExpression(e)) {
        const member = e.getName();
        const obj = e.getExpression();
        if (COMMON.has(member)) continue;
        if (obj.getKind() === SyntaxKind.ThisKeyword && impl.className) {
          t = { owner: impl.className, name: member, files: [impl.file], dirs, base: impl.baseName };
        } else if (obj.getKind() === SyntaxKind.SuperKeyword && impl.baseName) {
          t = { owner: impl.baseName, name: member, dirs };
        } else if (Node.isIdentifier(obj) && /^[A-Z]/.test(obj.getText())) {
          const owner = obj.getText();
          if (sameFile.has(owner)) t = { owner, name: member, files: [impl.file], dirs };
          else {
            const imp = fromImport(owner);
            if (imp) t = { ...(imp as Target), owner: imp.name!, name: member, dirs };
          }
        } else if (Node.isPropertyAccessExpression(obj) && obj.getExpression().getKind() === SyntaxKind.ThisKeyword) {
          // this._client.post(): by member name alone, resolved later if unique
          t = { owner: "*", name: member, dirs };
        }
      }
      if (!t) continue;
      const key = `${t.owner ?? ""}.${t.name}`;
      if (!out.has(key) && `${impl.className ?? ""}.${impl.label}` !== key) out.set(key, t);
    }
  }
  return [...out.values()];
};

const resolveRelativeFrom = (impl: Impl, spec: string) => (impl.snap ? resolveRelative(impl.snap, impl.file, spec) : undefined);

// a method found by name in exactly one class of the package
const locateUnique = async (snap: Snapshot, name: string, dirs: string[]): Promise<Found | undefined> => {
  const re = new RegExp(`^\\s*(?:(?:public|protected|private|static|async|override)\\s+)*${escapeRe(name)}\\s*[<(]`, "m");
  const files: string[] = [];
  for (const dir of dirs) {
    for (const [p, text] of await snap.read(scopeFiles(snap, dir))) if (re.test(text)) files.push(p);
  }
  if (files.length === 0 || files.length > 20) return undefined;
  const found: Found[] = [];
  for (const file of files) {
    const sf = parse(snap, file, (await snap.read([file])).get(file)!);
    for (const cls of sf.getClasses()) {
      const m = memberOf(cls, name);
      if (m && Node.isMethodDeclaration(m)) found.push({ file, sf, decl: cls, node: m, container: cls });
    }
  }
  return found.length === 1 ? found[0] : undefined;
};

const locateTarget = async (snap: Snapshot, t: Target) => {
  if (t.owner === "*") return locateUnique(snap, t.name, t.dirs);
  if (t.spec) {
    const pkgName = t.spec.startsWith("@") ? t.spec.split("/").slice(0, 2).join("/") : t.spec.split("/")[0]!;
    const ws = await snap.workspace(pkgName);
    return ws === undefined ? undefined : locate(snap, { owner: t.owner, name: t.name, dirs: [ws] });
  }
  const hit = await locate(snap, t);
  // inherited: this.x() declared on the base class
  return hit ?? (t.base ? locate(snap, { owner: t.base, name: t.name, dirs: t.dirs }) : undefined);
};

// --- unified diff --------------------------------------------------------------------------

const unified = async (a: string, b: string, labelA: string, labelB: string) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "safebump-impl-"));
  try {
    await writeFile(path.join(tmp, "a"), a.endsWith("\n") ? a : `${a}\n`);
    await writeFile(path.join(tmp, "b"), b.endsWith("\n") ? b : `${b}\n`);
    const r = await gitIn(tmp, ["diff", "--no-index", "--no-color", "--no-ext-diff", "-w", "--ignore-blank-lines", "-U3", "a", "b"]);
    const body = r.stdout.split("\n").filter((l, i, all) => i >= all.findIndex((x) => x.startsWith("@@")));
    return body.length > 0 && body[0]!.startsWith("@@") ? [`--- ${labelA}`, `+++ ${labelB}`, ...body].join("\n").trimEnd() : "";
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
};

// --- main ----------------------------------------------------------------------------------

const exact = async (projectRoot: string, pkg: string, v: string) => {
  if (semver.valid(v)) return v;
  const resolved = resolveVersion(await getPackument(projectRoot, pkg), v);
  if (!resolved) throw new Error(`No version of ${pkg} matches "${v}".`);
  return resolved;
};

const targetOf = (a: ApiRef, dir: string): Target => {
  if (a.owner && a.member) return { owner: a.owner, name: a.member, dirs: [dir] };
  const [head, tail] = a.api.split(".");
  if (!a.owner && tail && !a.member) return { owner: head, name: tail, dirs: [dir] };
  return { name: a.owner ?? a.member ?? head!, dirs: [dir] };
};

type Side = { snap: Snapshot; dir: string };

const blobUrl = (repo: RepoInfo | undefined, sha: string | undefined, file: string, start: number, end: number) =>
  repo?.host === "github.com" && sha ? `${repo.web}/blob/${sha}/${file}#L${start}-L${end}` : undefined;

const diffOne = async (
  a: ApiRef,
  oldSide: Side,
  newSide: Side,
  repo: RepoInfo | undefined,
  options: Required<Options>,
): Promise<ImplDiff> => {
  const result: ImplDiff = { api: a.api, oldRef: oldSide.snap.ref, newRef: newSide.snap.ref, changed: false, hunks: "", flags: [], callees: [] };
  const target = targetOf(a, newSide.dir);
  const [oldHit, newHit] = await Promise.all([
    locate(oldSide.snap, { ...target, dirs: [oldSide.dir] }),
    locate(newSide.snap, target),
  ]);
  if (!oldHit && !newHit) {
    result.note = `No implementation of ${a.api} found in either version${newSide.snap.builtOnly ? " (built code only; names may be minified)" : ""}.`;
    return result;
  }
  if (!newHit) {
    result.changed = true;
    result.file = oldHit!.file;
    result.flags.push({ kind: "deleted", detail: `${a.api} (was in ${oldHit!.file}) has no implementation in ${newSide.snap.ref}` });
    return result;
  }
  const newImpl = withSnap(toImpl(newHit, a.api), newSide.snap);
  result.file = newImpl.file;
  result.url = blobUrl(repo, newSide.snap.sha, newImpl.file, newImpl.start, newImpl.end);
  if (!oldHit) {
    result.changed = true;
    result.flags.push({ kind: "added", detail: `${a.api} is new in ${newSide.snap.ref} (${newImpl.file})`, line: newImpl.start });
    return result;
  }
  const oldImpl = withSnap(toImpl(oldHit, a.api), oldSide.snap);

  const hunks: string[] = [];
  const pairs: { label: string; o: Impl; n: Impl }[] = [{ label: a.api, o: oldImpl, n: newImpl }];

  // callees to calleeDepth, breadth first, from both sides' bodies
  let frontier = [{ o: oldImpl, n: newImpl }];
  const fresh: string[] = [];
  const seen = new Set<string>([`${newImpl.file}:${newImpl.start}`]);
  for (let depth = 0; depth < options.calleeDepth && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    const targets = new Map<string, Target>();
    for (const { o, n } of frontier) {
      for (const t of [...calleeTargets(n, [newSide.dir]), ...calleeTargets(o, [newSide.dir])]) {
        targets.set(`${t.owner ?? ""}.${t.name}`, t);
      }
    }
    // the API's own class first: this.#normalizeRetries() over helpers
    const ordered = [...targets].sort((x, y) => Number(x[1].owner !== newImpl.className) - Number(y[1].owner !== newImpl.className));
    for (const [key, t] of ordered.slice(0, newImpl.methods ? MAX_CALLEES * 2 : MAX_CALLEES)) {
      const oldT = { ...t, dirs: [oldSide.dir], files: t.files?.map((f) => f.replace(newImpl.file, oldImpl.file)) };
      const [o, n] = await Promise.all([locateTarget(oldSide.snap, oldT), locateTarget(newSide.snap, t)]);
      const label = (n ?? o) && t.owner === "*" ? `${nameOfContainer(n ?? o!)}.${t.name}` : key.replace(/^\./, "");
      if (!n && !o) continue;
      if (n && seen.has(`${n.file}:${n.node.getStartLineNumber()}`)) continue;
      if (n) seen.add(`${n.file}:${n.node.getStartLineNumber()}`);
      result.callees.push(label);
      if (!n) {
        result.flags.push({ kind: "deleted", detail: `callee \`${label}\` no longer exists` });
        continue;
      }
      if (!o) {
        fresh.push(label);
        // new code can still throw at callers that never threw before
        const impl = withSnap(toImpl(n, label), newSide.snap);
        for (const t of factsOf(impl, () => undefined).throws) {
          result.flags.push({ kind: "new-throw", detail: `in new \`${label}\`: \`${t.value}\``, line: t.line });
        }
        continue;
      }
      const pair = { o: withSnap(toImpl(o, label), oldSide.snap), n: withSnap(toImpl(n, label), newSide.snap) };
      pairs.push({ label, ...pair });
      next.push(pair);
    }
    frontier = next;
  }
  if (fresh.length > 0) result.flags.push({ kind: "added", detail: `new callees: ${fresh.join(", ")}` });

  const oldFiles = new Map<string, string>();
  const newFiles = new Map<string, string>();
  for (const [p, sf] of oldSide.snap.parsed) oldFiles.set(p, sf.getFullText());
  for (const [p, sf] of newSide.snap.parsed) newFiles.set(p, sf.getFullText());
  const oldLookup = constLookup(oldSide.snap, oldFiles);
  const newLookup = constLookup(newSide.snap, newFiles);

  for (const [i, { label, o, n }] of pairs.entries()) {
    const same = tokens(o.text) === tokens(n.text);
    if (same && i > 0) continue;
    // constants referenced from an unchanged body can still change
    const flags = flagsFor(factsOf(o, oldLookup), factsOf(n, newLookup), o, n);
    if (!same) result.changed = true;
    if (flags.length > 0) result.changed = true;
    result.flags.push(...flags.map((f) => (i === 0 ? f : { ...f, detail: `in \`${label}\`: ${f.detail}` })));
    if (i === 0 && n.methods && o.methods) {
      const changed = [...n.methods].filter(([m, t]) => o.methods!.has(m) && o.methods!.get(m) !== t).map(([m]) => m);
      const added = [...n.methods.keys()].filter((m) => !o.methods!.has(m));
      const removed = [...o.methods.keys()].filter((m) => !n.methods!.has(m));
      if (removed.length > 0) result.flags.push({ kind: "deleted", detail: `methods removed: ${removed.join(", ")}` });
      if (added.length > 0) result.flags.push({ kind: "added", detail: `methods added: ${added.join(", ")}` });
      if (changed.length > 0) result.note = `methods with changed bodies: ${changed.join(", ")}`;
    }
    if (!same) {
      const at = (impl: Impl, ref: string) => `${impl.file}@${ref} (${label})`;
      hunks.push(await unified(o.text, n.text, at(o, oldSide.snap.ref), at(n, newSide.snap.ref)));
    }
  }

  const lines = hunks.filter(Boolean).join("\n").split("\n");
  result.hunks = lines.length > options.maxHunkLines
    ? [...lines.slice(0, options.maxHunkLines), `… (${lines.length - options.maxHunkLines} more lines)`].join("\n")
    : lines.join("\n");
  return result;
};

const nameOfContainer = (f: Found) => (f.container && isClass(f.container) ? f.container.getName() ?? "?" : "?");

const withSnap = (impl: Impl, snap: Snapshot) => Object.assign(impl, { snap });

export const diffImplementations = async (
  projectRoot: string,
  pkg: string,
  from: string,
  to: string,
  apis: ApiRef[],
  options: Options = {},
): Promise<ImplDiffReport> => {
  const opts: Required<Options> = {
    calleeDepth: options.calleeDepth ?? 1,
    maxHunkLines: options.maxHunkLines ?? 120,
    source: options.source ?? "auto",
  };
  const report: ImplDiffReport = { package: pkg, from, to, diffs: [], notes: [] };
  const started = Date.now();
  let sides: [Side, Side] | undefined;
  let repo: RepoInfo | undefined;
  try {
    [report.from, report.to] = await Promise.all([exact(projectRoot, pkg, from), exact(projectRoot, pkg, to)]);
  } catch (e) {
    report.notes.push(e instanceof Error ? e.message : String(e));
    return report;
  }

  try {
    if (opts.source === "tarball") throw new Error("tarballs requested");
    const c = await resolveCommits(projectRoot, pkg, report.from, report.to);
    repo = c.repo;
    report.repo = c.repo.web;
    report.notes.push(...c.notes);
    const [o, n] = await Promise.all([
      repoSnapshot(c.dir, c.from.sha, c.from.ref),
      repoSnapshot(c.dir, c.to.sha, c.to.ref),
    ]);
    const dir = c.repo.directory ?? "";
    if (scopeFiles(n, dir).length === 0) throw new Error(`no source files under ${dir || "the repository root"} at ${c.to.ref}`);
    sides = [{ snap: o, dir }, { snap: n, dir }];
    report.notes.push(`Source: ${c.repo.web}${dir ? ` (${dir})` : ""} at ${c.from.ref} (${c.from.how}) → ${c.to.ref} (${c.to.how}).`);
    if (c.repo.host === "github.com") report.notes.push(`compare: ${c.repo.web}/compare/${c.from.sha}...${c.to.sha}`);
  } catch (e) {
    report.notes.push(`Repository source unavailable (${e instanceof Error ? e.message : String(e)}); using the published tarballs.`);
    repo = undefined;
    try {
      const [o, n] = await Promise.all([
        tarballSnapshot(projectRoot, pkg, report.from),
        tarballSnapshot(projectRoot, pkg, report.to),
      ]);
      sides = [{ snap: o, dir: "" }, { snap: n, dir: "" }];
      if (n.builtOnly) report.notes.push("The tarball ships built JavaScript only: code may be bundled or minified, so matches by name can miss.");
    } catch (e2) {
      report.notes.push(`Could not fetch the tarballs either: ${e2 instanceof Error ? e2.message : String(e2)}`);
      return report;
    }
  }

  for (const a of apis) {
    try {
      const d = await diffOne(a, sides[0], sides[1], repo, opts);
      if (sides[1].snap.builtOnly && !d.note) d.note = "Diffed built JavaScript (no source in the tarball).";
      report.diffs.push(d);
    } catch (e) {
      report.diffs.push({
        api: a.api, oldRef: sides[0].snap.ref, newRef: sides[1].snap.ref, changed: false, hunks: "", flags: [], callees: [],
        note: `Failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  report.notes.push(`Diffed ${apis.length} APIs in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  return report;
};

const FLAG_ORDER: ImplFlag["kind"][] = [
  "deleted", "signature-changed", "default-changed", "new-throw", "constant-changed", "branch-removed", "removed-throw", "branch-added", "added",
];

export const printImplDiff = (r: ImplDiffReport) => {
  console.log(`# ${r.package} ${r.from} → ${r.to}: implementation of the APIs this project uses`);
  for (const n of r.notes) console.log(`note: ${n}`);
  const changed = r.diffs.filter((d) => d.changed).length;
  console.log(`${changed} of ${r.diffs.length} changed.`);
  for (const d of r.diffs) {
    const status = d.changed ? "changed" : d.file ? "unchanged" : "not found";
    console.log(`\n## ${d.api}: ${status}${d.file ? ` (${d.file})` : ""}`);
    if (d.url) console.log(d.url);
    if (d.note) console.log(`note: ${d.note}`);
    const flags = [...d.flags].sort((a, b) => FLAG_ORDER.indexOf(a.kind) - FLAG_ORDER.indexOf(b.kind));
    for (const f of flags) console.log(`- ${f.kind}: ${f.detail}${f.line ? ` (L${f.line})` : ""}`);
    if (d.callees.length > 0) console.log(`callees followed: ${d.callees.join(", ")}`);
    if (d.hunks) {
      console.log("```diff");
      console.log(d.hunks);
      console.log("```");
    }
  }
};
