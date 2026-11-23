import { spawn } from "child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import {
  findBin,
  findPackageManager,
  installedVersion,
  readPackageJson,
  runScriptCommand,
} from "./packages";

// Which source lines tests actually execute, from a real coverage run. Static
// reachability (test-gaps) says a test imports a file; this says whether the
// line calling the dependency ran. Coverage goes to a temp dir; project files
// are never written.

export type CoverageRunner = "vitest" | "jest" | "node-test" | "node-v8";

export type CoverageResult = {
  available: boolean;
  runner?: CoverageRunner;
  command?: string;
  reason?: string;
  testsPassed?: boolean;
  failedOutputTail?: string;
  // 1-based lines per file relative to projectRoot, in original (TS) sources
  executed: Record<string, number[]>;
  // every file the run reported, executed or not
  files: string[];
  durationMs: number;
};

export type CoverageOptions = {
  sourceFiles: string[];
  testFiles?: string[];
  related?: boolean;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const TAIL_LINES = 60;

// ---- running ----

const stripAnsi = (s: string) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");

const tail = (output: string, lines = TAIL_LINES) =>
  output.trimEnd().split("\n").slice(-lines).join("\n");

// same as verify.ts: own process group so a hung runner's whole tree dies
const runWithTimeout = (
  command: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; output: string; timedOut: boolean }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      env: { ...process.env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: stripAnsi(output), timedOut });
    });
  });

const quote = (s: string) =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

// enough of sh word splitting for package.json scripts
const tokenize = (script: string) => {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script))) {
    tokens.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]!));
  }
  return tokens;
};

// node_modules/.bin of the package and every parent, for rebuilt commands
const binPath = (dir: string) => {
  const dirs: string[] = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const bin = path.join(d, "node_modules", ".bin");
    if (existsSync(bin)) dirs.push(bin);
    if (path.dirname(d) === d) break;
  }
  return [...dirs, process.env.PATH ?? ""].join(path.delimiter);
};

// ---- runner detection ----

type Detected =
  | { runner: CoverageRunner; segment: string; script?: string }
  | { runner: undefined; reason: string };

const DELEGATE = /^(?:npm run(?:-script)?|pnpm(?: run)?|yarn(?: run)?|bun run)\s+(?:--silent\s+)?([\w:.-]+)$/;

// follows `"test": "npm run test:unit"` to the script that does the work
const testScript = (scripts: Record<string, string>) => {
  let script = scripts.test;
  for (let i = 0; i < 3 && script; i++) {
    const m = DELEGATE.exec(script.trim());
    if (!m || !scripts[m[1]!]) break;
    script = scripts[m[1]!];
  }
  return script;
};

const NODE_TEST = /(^|\s)(node|tsx)\s(.*\s)?--test\b/;

const detectRunner = (projectRoot: string): Detected => {
  const pkg = readPackageJson(projectRoot) ?? {};
  const script = testScript(pkg.scripts ?? {});
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!script || /no test specified/.test(script)) {
    if (deps.vitest) return { runner: "vitest", segment: "vitest run" };
    if (deps.jest) return { runner: "jest", segment: "jest" };
    return { runner: undefined, reason: "no test script in package.json" };
  }
  // `tsc && vitest run`: only the part that runs tests
  const segments = script.split(/\s*(?:&&|\|\||;)\s*/);
  const find = (re: RegExp) => segments.find((s) => re.test(s));
  let s: string | undefined;
  if ((s = find(/vitest/))) return { runner: "vitest", segment: s, script };
  if ((s = find(/\bjest\b/)) && !/react-scripts|craco/.test(s)) {
    return { runner: "jest", segment: s, script };
  }
  if ((s = find(NODE_TEST))) return { runner: "node-test", segment: s, script };
  if (/^\s*(bun|deno)\b/.test(script) || /\bbun test\b/.test(script)) {
    return { runner: undefined, reason: `not a Node test runner: ${script}` };
  }
  if (/react-scripts|craco/.test(script)) {
    return { runner: undefined, reason: `unsupported wrapper (run jest directly): ${script}` };
  }
  return { runner: "node-v8", segment: script, script };
};

// options the project passes its runner (--project, --config, --root); the
// subcommand and file filters before the first option are replaced by ours
const runnerArgs = (segment: string, bin: RegExp) => {
  const tokens = tokenize(segment);
  const at = tokens.findIndex((t) => bin.test(t));
  const rest = at < 0 ? [] : tokens.slice(at + 1);
  const firstOption = rest.findIndex((t) => t.startsWith("-"));
  return firstOption < 0 ? [] : rest.slice(firstOption);
};

// leading `FOO=1` / `cross-env FOO=1` assignments, kept for our command
const envPrefix = (segment: string) => {
  const tokens = tokenize(segment);
  const out: string[] = [];
  for (const t of tokens) {
    if (t === "cross-env" || /^\w+=/.test(t)) out.push(t);
    else break;
  }
  return out.filter((t) => t !== "cross-env");
};

const optionValue = (args: string[], names: string[]) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n) return args[i + 1];
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return undefined;
};

// ---- istanbul (vitest, jest) ----

type Pos = { line: number; column: number | null };
type Loc = { start: Pos; end: Pos };
type IstanbulFile = {
  path: string;
  statementMap: Record<string, Loc>;
  s: Record<string, number>;
  fnMap?: Record<string, { loc: Loc }>;
  f?: Record<string, number>;
};

// A line is executed when a statement starting on it ran. A line where no
// statement starts (the 2nd line of a multi-line call) takes the count of the
// innermost statement or function spanning it. Marking every line of a
// counted statement's range instead would mark the body of
// `const f = () => {...}` as executed whenever the module loads, even if f is
// never called. Granularity is per statement: `xs.map((x) => dep(x))` on one
// line counts as executed when the map call ran, even with xs empty.
const istanbulLines = (file: IstanbulFile) => {
  const span = (loc: Loc, count: number) => ({
    start: loc.start.line,
    end: loc.end.line,
    startCol: loc.start.column ?? 0,
    count,
  });
  const stmts = Object.entries(file.statementMap).map(([id, loc]) => span(loc, file.s[id] ?? 0));
  const containers = [
    ...stmts,
    ...Object.entries(file.fnMap ?? {}).map(([id, fn]) => span(fn.loc, file.f?.[id] ?? 0)),
  ];
  const starting = new Map<number, boolean>();
  for (const st of stmts) {
    starting.set(st.start, (starting.get(st.start) ?? false) || st.count > 0);
  }
  const maxLine = Math.max(0, ...stmts.map((st) => st.end));
  const lines: number[] = [];
  for (let line = 1; line <= maxLine; line++) {
    const own = starting.get(line);
    if (own !== undefined) {
      if (own) lines.push(line);
      continue;
    }
    let inner: (typeof stmts)[number] | undefined;
    for (const st of containers) {
      if (st.start >= line || st.end < line) continue;
      if (!inner || st.start > inner.start || (st.start === inner.start && st.startCol > inner.startCol)) {
        inner = st;
      }
    }
    if (inner && inner.count > 0) lines.push(line);
  }
  return lines;
};

const readIstanbul = (dir: string): IstanbulFile[] => {
  const file = path.join(dir, "coverage-final.json");
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, "utf-8")) as Record<string, IstanbulFile>;
  return Object.entries(data).map(([key, f]) => ({ ...f, path: f.path ?? key }));
};

// ---- V8 (node --test, generic) ----

type V8Range = { startOffset: number; endOffset: number; count: number };
type V8Script = { url: string; functions: { ranges: V8Range[] }[] };
type SourceMapData = {
  sources: string[];
  sourceRoot?: string;
  mappings: string;
  sections?: unknown;
};
type V8File = {
  result: V8Script[];
  "source-map-cache"?: Record<string, { lineLengths?: number[]; data?: SourceMapData }>;
};

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

// source map "mappings": per generated line, [generatedColumn, sourceIndex,
// sourceLine (0-based)] for each segment that maps somewhere
export const decodeMappings = (mappings: string) => {
  const lines: [number, number, number][][] = [];
  let source = 0;
  let srcLine = 0;
  let srcCol = 0;
  let name = 0;
  for (const lineText of mappings.split(";")) {
    const segments: [number, number, number][] = [];
    let genCol = 0;
    for (const seg of lineText.split(",")) {
      if (!seg) continue;
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const c of seg) {
        const digit = B64_INDEX.get(c);
        if (digit === undefined) break;
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      genCol += fields[0] ?? 0;
      if (fields.length >= 4) {
        source += fields[1]!;
        srcLine += fields[2]!;
        srcCol += fields[3]!;
        if (fields.length >= 5) name += fields[4]!;
        segments.push([genCol, source, srcLine]);
      }
    }
    lines.push(segments);
  }
  return lines;
};

// V8 block coverage: ranges nest, and the innermost range covering an
// offset holds its count (a 0-count block inside a called function was
// skipped). Painting outer ranges first, then inner ones, gives that.
const executedOffsets = (script: V8Script, length: number) => {
  const ranges = script.functions.flatMap((f) => f.ranges);
  ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const ran = new Uint8Array(length);
  for (const r of ranges) {
    ran.fill(r.count > 0 ? 1 : 0, Math.max(0, r.startOffset), Math.min(length, r.endOffset));
  }
  return ran;
};

const lineStarts = (lengths: number[]) => {
  const starts: number[] = [];
  let offset = 0;
  for (const len of lengths) {
    starts.push(offset);
    offset += len + 1;
  }
  return { starts, length: offset };
};

const urlToPath = (url: string) => {
  try {
    return url.startsWith("file:") ? fileURLToPath(url) : path.isAbsolute(url) ? url : undefined;
  } catch {
    return undefined;
  }
};

const resolveSource = (scriptPath: string, map: SourceMapData, source: string) =>
  source.startsWith("file:")
    ? urlToPath(source)
    : path.resolve(path.dirname(scriptPath), map.sourceRoot ?? "", source);

const addLine = (into: Map<string, Set<number>>, file: string, line: number) => {
  const set = into.get(file) ?? new Set<number>();
  set.add(line);
  into.set(file, set);
};

// executed original lines of one script: a line ran when any mapping segment
// on it points at executed code, so a line holding both `xs.map(` and an
// uncalled callback counts. Files it maps to are recorded even when nothing
// in them ran.
const v8ScriptLines = (
  script: V8Script,
  cache: V8File["source-map-cache"],
  executed: Map<string, Set<number>>,
  seen: Set<string>,
  wanted: (abs: string) => boolean,
) => {
  const scriptPath = urlToPath(script.url);
  if (!scriptPath) return;
  const cached = cache?.[script.url];
  const map = cached?.data && !cached.data.sections ? cached.data : undefined;

  if (map && cached?.lineLengths) {
    const sources = map.sources.map((s) => resolveSource(scriptPath, map, s));
    if (!sources.some((s) => s && wanted(s))) return;
    const { starts, length } = lineStarts(cached.lineLengths);
    const ran = executedOffsets(script, length);
    for (const s of sources) if (s && wanted(s)) seen.add(s);
    decodeMappings(map.mappings).forEach((segments, genLine) => {
      for (const [col, src, srcLine] of segments) {
        const file = sources[src];
        if (!file || !wanted(file)) continue;
        if (ran[(starts[genLine] ?? length) + col]) addLine(executed, file, srcLine + 1);
      }
    });
    return;
  }

  // no source map: offsets are into the file as on disk (plain JS, or TS run
  // with Node's type stripping, which keeps positions)
  if (!wanted(scriptPath) || !existsSync(scriptPath)) return;
  seen.add(scriptPath);
  const text = readFileSync(scriptPath, "utf-8");
  const lines = text.split("\n");
  const { starts, length } = lineStarts(lines.map((l) => l.length));
  const ran = executedOffsets(script, length);
  lines.forEach((l, i) => {
    for (let c = 0; c < l.length; c++) {
      if (!/\s/.test(l[c]!) && ran[starts[i]! + c]) {
        addLine(executed, scriptPath, i + 1);
        break;
      }
    }
  });
};

const readV8 = (dir: string, wanted: (abs: string) => boolean) => {
  const executed = new Map<string, Set<number>>();
  const seen = new Set<string>();
  // one file per process (node --test runs each test file in its own)
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    let data: V8File;
    try {
      data = JSON.parse(readFileSync(path.join(dir, f), "utf-8")) as V8File;
    } catch {
      continue;
    }
    for (const script of data.result ?? []) {
      if (!script.url.startsWith("file:") && !path.isAbsolute(script.url)) continue;
      v8ScriptLines(script, data["source-map-cache"], executed, seen, wanted);
    }
  }
  return { executed, seen };
};

// ---- per-runner commands ----

type Plan = { command: string; env?: NodeJS.ProcessEnv; format: "istanbul" | "v8"; note?: string };

const major = (v: string | undefined) => (v ? Number(v.split(".")[0]) : undefined);

const vitestPlan = (
  projectRoot: string,
  segment: string,
  options: CoverageOptions,
  tmp: string,
): Plan | string => {
  const bin = findBin(projectRoot, "vitest");
  if (!bin) return "vitest is not installed (node_modules/.bin/vitest missing); run the package manager's install";
  const provider = installedVersion(projectRoot, "@vitest/coverage-v8")
    ? "v8"
    : installedVersion(projectRoot, "@vitest/coverage-istanbul")
      ? "istanbul"
      : undefined;
  if (!provider) {
    return "no vitest coverage provider installed: add @vitest/coverage-v8 as a devDependency (same version as vitest) to measure executed lines";
  }
  const args = runnerArgs(segment, /vitest/);
  // --root moves where vitest resolves coverage.include from
  const root = path.resolve(projectRoot, optionValue(args, ["--root", "-r"]) ?? ".");
  const abs = (f: string) => path.resolve(projectRoot, f);
  const vitestMajor = major(installedVersion(projectRoot, "vitest"));

  const head = options.testFiles?.length
    ? ["run", ...options.testFiles]
    : options.related !== false
      ? ["related", "--run", ...options.sourceFiles.map(abs)]
      : ["run"];
  const coverage = [
    "--coverage.enabled=true",
    `--coverage.provider=${provider}`,
    "--coverage.reporter=json",
    `--coverage.reportsDirectory=${tmp}`,
    "--coverage.reportOnFailure=true",
    // thresholds would fail a partial run, and autoUpdate rewrites the config
    "--coverage.thresholds.autoUpdate=false",
    ...["lines", "functions", "branches", "statements"].map((k) => `--coverage.thresholds.${k}=0`),
    // `all` is gone in vitest 4, where only `include` adds unloaded files
    ...(vitestMajor !== undefined && vitestMajor < 4 ? ["--coverage.all=false"] : []),
    ...options.sourceFiles.map((f) => `--coverage.include=${path.relative(root, abs(f))}`),
  ];
  return {
    command: [...envPrefix(segment), bin, ...head, ...args, ...coverage].map(quote).join(" "),
    format: "istanbul",
  };
};

const jestPlan = (
  projectRoot: string,
  segment: string,
  options: CoverageOptions,
  tmp: string,
): Plan | string => {
  const bin = findBin(projectRoot, "jest");
  if (!bin) return "jest is not installed (node_modules/.bin/jest missing); run the package manager's install";
  const select = options.testFiles?.length
    ? ["--runTestsByPath", ...options.testFiles]
    : options.related !== false
      ? ["--findRelatedTests", ...options.sourceFiles]
      : [];
  const args = [
    "--ci",
    "--coverage",
    "--coverageReporters=json",
    `--coverageDirectory=${tmp}`,
    "--coverageThreshold={}",
    ...options.sourceFiles.map((f) => `--collectCoverageFrom=${f}`),
    ...runnerArgs(segment, /\bjest\b/),
    // variadic, so last
    ...select,
  ];
  return {
    command: [...envPrefix(segment), bin, ...args].map(quote).join(" "),
    format: "istanbul",
  };
};

const v8Env = (tmp: string): NodeJS.ProcessEnv => ({
  NODE_V8_COVERAGE: tmp,
  // makes Node keep the source maps tsx/ts-node emit, written into the
  // coverage JSON as "source-map-cache"
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --enable-source-maps`.trim(),
});

const LOOKS_LIKE_FILE = /[/*]|\.[cm]?[jt]sx?$/;

const nodeTestPlan = (
  projectRoot: string,
  segment: string,
  options: CoverageOptions,
  tmp: string,
): Plan => {
  const pm = findPackageManager(projectRoot);
  if (!options.testFiles?.length) {
    return {
      command: runScriptCommand(pm, "test"),
      env: v8Env(tmp),
      format: "v8",
      note: options.related !== false ? "node --test can't select related tests; ran the whole test script" : undefined,
    };
  }
  // the script's own flags (--import tsx) with our test files
  const tokens = tokenize(segment);
  const at = tokens.indexOf("--test");
  const kept = tokens.filter((t, i) => i <= at || !LOOKS_LIKE_FILE.test(t) || t.startsWith("-"));
  return {
    command: [...kept, ...options.testFiles].map(quote).join(" "),
    env: { ...v8Env(tmp), PATH: binPath(projectRoot) },
    format: "v8",
  };
};

const genericPlan = (projectRoot: string, options: CoverageOptions, tmp: string): Plan => {
  const caveats = [
    options.testFiles?.length ? "can't pass test files to a custom test script; ran all of it" : "",
    "generic V8 coverage: lines in code run in vm contexts or separate non-Node processes aren't seen",
  ].filter(Boolean);
  return {
    command: runScriptCommand(findPackageManager(projectRoot), "test"),
    env: v8Env(tmp),
    format: "v8",
    note: caveats.join("; "),
  };
};

// ---- entry ----

const relKey = (projectRoot: string, abs: string) =>
  path.relative(projectRoot, abs).split(path.sep).join("/");

const normalize = (f: string) => path.normalize(f).split(path.sep).join("/").replace(/^\.\//, "");

// vitest prints "ERROR: Coverage for lines (3%) does not meet ..." and exits
// 1 even with thresholds zeroed by some configs (per-glob thresholds)
const onlyThresholdFailure = (output: string) =>
  /does not meet (global )?threshold/i.test(output) &&
  !/(\d+ failed|✗|×|FAIL\s)/.test(output);

export const measureCoverage = async (
  projectRoot: string,
  options: CoverageOptions,
): Promise<CoverageResult> => {
  const started = Date.now();
  const root = path.resolve(projectRoot);
  const empty = (extra: Partial<CoverageResult>): CoverageResult => ({
    available: false,
    executed: {},
    files: [],
    durationMs: Date.now() - started,
    ...extra,
  });

  const detected = detectRunner(root);
  if (!detected.runner) return empty({ reason: detected.reason });

  const tmp = mkdtempSync(path.join(os.tmpdir(), "safebump-coverage-"));
  try {
    const plan =
      detected.runner === "vitest"
        ? vitestPlan(root, detected.segment, options, tmp)
        : detected.runner === "jest"
          ? jestPlan(root, detected.segment, options, tmp)
          : detected.runner === "node-test"
            ? nodeTestPlan(root, detected.segment, options, tmp)
            : genericPlan(root, options, tmp);
    if (typeof plan === "string") return empty({ runner: detected.runner, reason: plan });

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const r = await runWithTimeout(plan.command, root, timeoutMs, plan.env);
    const passed = !r.timedOut && (r.code === 0 || onlyThresholdFailure(r.output));

    const wantedKeys = new Set(options.sourceFiles.map(normalize));
    const wanted = (abs: string) => {
      const key = relKey(root, abs);
      if (key.startsWith("../") || key.includes("node_modules/")) return false;
      return wantedKeys.size === 0 || wantedKeys.has(key);
    };

    const executed: Record<string, number[]> = {};
    const files = new Set<string>();
    if (plan.format === "istanbul") {
      for (const f of readIstanbul(tmp)) {
        // jest (collectCoverageFrom) and vitest 4 (include) add files no test
        // loaded, all zeros; a loaded module runs at least its imports
        const loaded = [...Object.values(f.s), ...Object.values(f.f ?? {})].some((n) => n > 0);
        if (!wanted(f.path) || !loaded) continue;
        const key = relKey(root, f.path);
        files.add(key);
        const lines = istanbulLines(f);
        if (lines.length > 0) executed[key] = lines;
      }
    } else {
      const v8 = readV8(tmp, wanted);
      for (const f of v8.seen) files.add(relKey(root, f));
      for (const [f, lines] of v8.executed) {
        executed[relKey(root, f)] = [...lines].sort((a, b) => a - b);
      }
    }

    const reasons = [
      plan.note,
      r.timedOut ? `killed after ${timeoutMs / 1000}s timeout` : "",
      files.size === 0 ? "the run reported none of the source files (no test loaded them, or the runner wrote no coverage)" : "",
    ].filter(Boolean);
    return {
      available: files.size > 0 || passed,
      runner: detected.runner,
      command: plan.command,
      reason: reasons.length > 0 ? reasons.join("; ") : undefined,
      testsPassed: passed,
      failedOutputTail: passed ? undefined : tail(r.output),
      executed,
      files: [...files].sort(),
      durationMs: Date.now() - started,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

// "3-5, 9, 12" from [3, 4, 5, 9, 12]
const ranges = (lines: number[]) => {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j]! + 1) j++;
    out.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
    i = j;
  }
  return out.join(", ");
};

export const printCoverage = (r: CoverageResult) => {
  if (!r.available) {
    console.log(`Coverage unavailable${r.runner ? ` (${r.runner})` : ""}: ${r.reason ?? "unknown reason"}`);
    if (r.failedOutputTail) console.log(`\n${r.failedOutputTail}`);
    return;
  }
  console.log(`# Coverage (${r.runner}, ${(r.durationMs / 1000).toFixed(1)}s)`);
  console.log(`command: ${r.command}`);
  console.log(`tests: ${r.testsPassed ? "passed" : "FAILED (coverage below may be partial)"}`);
  if (r.reason) console.log(`note: ${r.reason}`);
  for (const f of r.files) {
    const lines = r.executed[f] ?? [];
    console.log(`- ${f}: ${lines.length > 0 ? `executed lines ${ranges(lines)}` : "loaded, no line executed"}`);
  }
  if (!r.testsPassed && r.failedOutputTail) console.log(`\n${r.failedOutputTail}`);
};
