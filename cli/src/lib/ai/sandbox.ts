import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import path from "path";

// The reviewer's only access to the machine. Every path is confined to the
// project root (after resolving symlinks); node_modules is off limits except
// the upgraded packages' own folders and read_package_file; writes are only
// to test files. No shell.

export const MAX_READ_BYTES = 256 * 1024;
export const MAX_TOOL_OUTPUT = 60_000;
export const MAX_WRITE_BYTES = 200 * 1024;
const MAX_LIST = 500;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILES = 5000;
const MAX_GREP_LINE = 400;

export class SandboxError extends Error {}

// same rule as audit.ts, but __tests__/ only for code files
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\/.+\.[cm]?[jt]sx?$/;

// files that may hold credentials: never shown to the model
const SECRET_FILE =
  /(^|\/)(\.env(\..*)?|\.npmrc|\.yarnrc(\.yml)?|\.netrc|\.pypirc|id_[rd]sa[^/]*|.*\.(pem|key|p12|pfx|keystore|jks)|credentials(\.json)?|.*service[-_]?account.*\.json)$/i;
// version control internals and other tools' state
const HIDDEN_DIR = /(^|\/)(\.git|\.hg|\.svn|\.safebump)(\/|$)/;

// code that would turn "write a test, run it" into arbitrary command execution
const FORBIDDEN_IN_TESTS: [RegExp, string][] = [
  [/\bchild_process\b/, "child_process"],
  [/\bworker_threads\b/, "worker_threads"],
  [/['"`](execa|shelljs|zx|cross-spawn|node-pty)['"`]/, "a process-spawning package"],
  [/\bprocess\s*\.\s*(binding|dlopen|kill)\b/, "process.binding/dlopen/kill"],
  [/\bBun\s*\.\s*(spawn|\$)|\bDeno\s*\.\s*(run|Command)\b/, "Bun/Deno process APIs"],
  [/\b(eval|Function)\s*\(/, "eval / new Function"],
  [/\bprocess\s*\.\s*env\b(?!\s*\.\s*(NODE_ENV|TZ|CI)\b)/, "process.env (other than NODE_ENV/TZ/CI)"],
];

const PKG_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

const toPosix = (p: string) => p.split(path.sep).join("/");

const within = (parent: string, child: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// realpath of the path, or of its nearest existing ancestor plus the rest
const realish = (abs: string) => {
  let cur = abs;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(realpathSync(cur), ...rest);
};

// minimal glob: **, *, ?, {a,b}; matched against the path relative to the dir
export const globToRegExp = (glob: string) => {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) re += "\\{";
      else {
        re += `(?:${glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  // a pattern without a slash matches the basename anywhere
  return new RegExp(glob.includes("/") ? `^${re}$` : `(^|/)${re}$`);
};

export const clipOutput = (s: string, max = MAX_TOOL_OUTPUT) =>
  s.length > max ? `${s.slice(0, max)}\n… [truncated ${s.length - max} characters]` : s;

export type SandboxOptions = {
  // packages whose node_modules folder read_file/list_files/grep may enter
  readablePackages?: string[];
  allowTestWrites?: boolean;
};

export class Sandbox {
  readonly root: string;
  readonly filesWritten: string[] = [];
  private readonly readablePackageDirs: string[];
  private readonly allowTestWrites: boolean;

  constructor(projectRoot: string, options: SandboxOptions = {}) {
    this.root = realpathSync(path.resolve(projectRoot));
    this.allowTestWrites = options.allowTestWrites ?? true;
    this.readablePackageDirs = (options.readablePackages ?? [])
      .filter((p) => PKG_NAME.test(p))
      .map((p) => path.join(this.root, "node_modules", ...p.split("/")))
      .filter((d) => existsSync(d))
      .map((d) => toPosix(path.relative(this.root, d)));
  }

  // project-relative posix path for a model-supplied path, or throws
  resolve(input: string, opts: { allowMissing?: boolean } = {}) {
    if (typeof input !== "string" || input.includes("\0")) throw new SandboxError("invalid path");
    const cleaned = input.trim() === "" ? "." : input.trim();
    const abs = path.resolve(this.root, cleaned);
    if (!within(this.root, abs)) throw new SandboxError(`path is outside the project: ${input}`);
    if (!opts.allowMissing && !existsSync(abs)) throw new SandboxError(`no such file or directory: ${input}`);
    const real = realish(abs);
    if (!within(this.root, real)) throw new SandboxError(`path resolves (via a symlink) outside the project: ${input}`);
    const rel = toPosix(path.relative(this.root, abs));
    const realRel = toPosix(path.relative(this.root, real));
    for (const r of [rel, realRel]) {
      if (HIDDEN_DIR.test(r)) throw new SandboxError(`not readable: ${input}`);
      if (this.inNodeModules(r) && !this.readablePackageDirs.some((d) => r === d || r.startsWith(`${d}/`))) {
        throw new SandboxError(`node_modules is not readable here (except ${this.readablePackageDirs.join(", ") || "nothing"}); use read_package_file for installed packages`);
      }
    }
    return { rel: rel === "" ? "." : rel, abs };
  }

  private inNodeModules = (rel: string) => /(^|\/)node_modules(\/|$)/.test(rel);

  private assertReadable(rel: string) {
    if (SECRET_FILE.test(rel)) throw new SandboxError(`refusing to read a file that may hold credentials: ${rel}`);
  }

  readFile(input: string, startLine?: number, endLine?: number) {
    const { rel, abs } = this.resolve(input);
    this.assertReadable(rel);
    return this.readAbs(abs, rel, startLine, endLine);
  }

  private readAbs(abs: string, label: string, startLine?: number, endLine?: number) {
    const st = statSync(abs);
    if (st.isDirectory()) throw new SandboxError(`${label} is a directory; use list_files`);
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) throw new SandboxError(`${label} looks binary`);
    const lines = buf.toString("utf-8").split("\n");
    const from = Math.max(1, Math.floor(startLine ?? 1));
    const to = Math.min(lines.length, Math.floor(endLine ?? lines.length));
    let out = "";
    let last = from - 1;
    for (let i = from; i <= to; i++) {
      const line = `${i}\t${lines[i - 1]}\n`;
      if (out.length + line.length > MAX_READ_BYTES) break;
      out += line;
      last = i;
    }
    const more = last < to ? `\n[stopped at line ${last} of ${lines.length}: size cap; read on with startLine=${last + 1}]` : "";
    return `${label} (lines ${from}-${last} of ${lines.length})\n${out}${more}`;
  }

  // walk dir (project-relative), skipping hidden dirs and node_modules
  // (resolve() has already allowed relDir)
  private *walk(relDir: string): Generator<string> {
    const stack = [relDir];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      const abs = path.join(this.root, dir);
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const dirs: string[] = [];
      for (const e of entries) {
        const rel = dir === "." ? e.name : `${dir}/${e.name}`;
        if (HIDDEN_DIR.test(rel)) continue;
        // symlinks are listed but never followed
        if (e.isSymbolicLink()) {
          yield rel;
          continue;
        }
        // node_modules only when the walk starts inside a readable package
        if (e.isDirectory()) {
          if (e.name !== "node_modules") dirs.push(rel);
        } else if (e.isFile()) {
          yield rel;
        }
      }
      stack.push(...dirs.reverse());
    }
  }

  listFiles(dir = ".", glob?: string) {
    const { rel } = this.resolve(dir);
    if (!statSync(path.join(this.root, rel)).isDirectory()) throw new SandboxError(`${dir} is not a directory`);
    const re = glob ? globToRegExp(glob) : undefined;
    const out: string[] = [];
    let total = 0;
    for (const f of this.walk(rel)) {
      const sub = rel === "." ? f : f.slice(rel.length + 1);
      if (re && !re.test(sub)) continue;
      total++;
      if (out.length < MAX_LIST) out.push(f);
    }
    return out.length === 0
      ? `no files${glob ? ` matching ${glob}` : ""} under ${rel}`
      : `${out.join("\n")}${total > out.length ? `\n… ${total - out.length} more (narrow with dir or glob)` : ""}`;
  }

  grep(pattern: string, dir = ".", glob?: string) {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      throw new SandboxError(`invalid regex: ${(e as Error).message}`);
    }
    const { rel, abs } = this.resolve(dir);
    const files = statSync(abs).isDirectory() ? this.walk(rel) : [rel][Symbol.iterator]();
    const globRe = glob ? globToRegExp(glob) : undefined;
    const matches: string[] = [];
    let scanned = 0;
    for (const f of files) {
      if (SECRET_FILE.test(f) || (globRe && !globRe.test(f))) continue;
      if (++scanned > MAX_GREP_FILES) {
        matches.push(`… stopped after ${MAX_GREP_FILES} files (narrow the path)`);
        break;
      }
      const fabs = path.join(this.root, f);
      let buf: Buffer;
      try {
        if (lstatSync(fabs).isSymbolicLink() || statSync(fabs).size > 2_000_000) continue;
        buf = readFileSync(fabs);
      } catch {
        continue;
      }
      if (buf.subarray(0, 8000).includes(0)) continue;
      const lines = buf.toString("utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // long lines (minified code) make pathological regexes slow
        if (line.length > 4000) continue;
        if (re.test(line)) {
          matches.push(`${f}:${i + 1}: ${line.length > MAX_GREP_LINE ? `${line.slice(0, MAX_GREP_LINE)}…` : line}`);
          if (matches.length >= MAX_GREP_MATCHES) {
            matches.push(`… stopped at ${MAX_GREP_MATCHES} matches`);
            return matches.join("\n");
          }
        }
      }
    }
    return matches.length === 0 ? `no matches for /${pattern}/ under ${rel}` : matches.join("\n");
  }

  // an installed package's files (docs, .d.ts), from the project's
  // node_modules or a parent's (hoisted workspaces)
  readPackageFile(pkg: string, file: string, startLine?: number, endLine?: number) {
    if (!PKG_NAME.test(pkg)) throw new SandboxError(`invalid package name: ${pkg}`);
    let pkgDir: string | undefined;
    for (let d = this.root; ; d = path.dirname(d)) {
      const candidate = path.join(d, "node_modules", ...pkg.split("/"));
      if (existsSync(path.join(candidate, "package.json"))) {
        pkgDir = realpathSync(candidate);
        break;
      }
      if (path.dirname(d) === d) break;
    }
    if (!pkgDir) throw new SandboxError(`${pkg} is not installed`);
    const abs = path.resolve(pkgDir, file || ".");
    if (!within(pkgDir, abs) || !existsSync(abs)) throw new SandboxError(`no such file in ${pkg}: ${file}`);
    if (!within(pkgDir, realpathSync(abs))) throw new SandboxError(`path resolves outside ${pkg}: ${file}`);
    const rel = toPosix(path.relative(pkgDir, abs));
    if (SECRET_FILE.test(rel)) throw new SandboxError(`refusing to read a file that may hold credentials: ${rel}`);
    if (statSync(abs).isDirectory()) {
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.name !== "node_modules")
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return `${pkg}/${rel || "."}:\n${entries.slice(0, MAX_LIST).join("\n")}`;
    }
    return this.readAbs(abs, `${pkg}/${rel}`, startLine, endLine);
  }

  writeTestFile(input: string, content: string) {
    if (!this.allowTestWrites) throw new SandboxError("writing files is disabled for this review");
    if (typeof content !== "string") throw new SandboxError("content must be a string");
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new SandboxError(`content is over ${MAX_WRITE_BYTES} bytes`);
    const { rel, abs } = this.resolve(input, { allowMissing: true });
    if (!TEST_FILE.test(rel)) {
      throw new SandboxError(`only test files may be written (*.test.*, *.spec.*, or code under __tests__/): ${rel}`);
    }
    if (this.inNodeModules(rel)) throw new SandboxError("can't write into node_modules");
    if (existsSync(abs)) {
      const st = lstatSync(abs);
      if (st.isSymbolicLink() || !st.isFile()) throw new SandboxError(`${rel} is not a regular file`);
    }
    for (const [re, what] of FORBIDDEN_IN_TESTS) {
      if (re.test(content)) throw new SandboxError(`test files may not use ${what}`);
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    // re-check after mkdir: a racing symlink in the parent chain
    if (!within(this.root, realish(abs))) throw new SandboxError(`path resolves outside the project: ${rel}`);
    const existed = existsSync(abs);
    writeFileSync(abs, content);
    if (!this.filesWritten.includes(rel)) this.filesWritten.push(rel);
    return `${existed ? "updated" : "created"} ${rel} (${content.split("\n").length} lines)`;
  }

  // test files for run_tests: existing, in the project, named like tests
  testFiles(files: string[]) {
    if (!Array.isArray(files) || files.length === 0) throw new SandboxError("give at least one test file");
    return files.map((f) => {
      const { rel } = this.resolve(f);
      if (!TEST_FILE.test(rel)) throw new SandboxError(`not a test file: ${rel}`);
      return rel;
    });
  }
}
