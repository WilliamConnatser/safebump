import { existsSync } from "fs";
import path from "path";

import type { BuildError } from "./types";
import {
  directDependencies,
  findBin,
  findPackageManager,
  readPackageJson,
  runScriptCommand,
} from "./packages";
import { run } from "./subprocess";
import { tsconfigReferences } from "./typescript/index";

// Type checkers that speak tsc's command line and diagnostic format, most
// specific first: a project that installed an alternative checker wants it
// used over the `typescript` package its tooling also pulls in.
const CHECKERS = [
  { bin: "tsc-rs", pkg: "tsc-rs", name: "ts-rust" },
  { bin: "tsgo", pkg: "@typescript/native-preview", name: "tsgo" },
  { bin: "vue-tsc", pkg: "vue-tsc", name: "vue-tsc" },
  { bin: "tsc", pkg: "typescript", name: "tsc" },
] as const;

// in order of preference; "build:check"-style names come last because they
// sometimes do more than type-check
const TYPECHECK_SCRIPTS = [
  "typecheck",
  "type-check",
  "check-types",
  "check:types",
  "types:check",
  "types",
  "tsc",
  "lint:types",
  "typecheck:root",
  "build:check:root",
  "build:check",
  "check",
];

export type Checker = {
  command: string;
  // why this command was chosen, shown to the agent
  source: string;
};

export const resolveChecker = (
  projectRoot: string,
  override?: string,
): Checker => {
  const explicit = override ?? process.env.SAFEBUMP_TYPECHECK;
  if (explicit) {
    return {
      command: explicit,
      source: override ? "--checker" : "SAFEBUMP_TYPECHECK",
    };
  }

  // the project's own script knows about project references, multiple
  // tsconfigs and custom flags, so prefer it when it runs a known checker
  const scripts = readPackageJson(projectRoot)?.scripts ?? {};
  // a known checker binary, or a wrapper script named like one
  // (e.g. `node ./scripts/run-native-tsc.mjs --noEmit`)
  const checkerPattern = new RegExp(
    `(^|[\\s;&|/])(${CHECKERS.map((c) => c.bin).join("|")})(\\s|$)|[\\w./-]*(tsc|tsgo)[\\w-]*\\.[cm]?[jt]s\\b`,
  );
  const usable = (script: string) =>
    checkerPattern.test(script) &&
    !/--watch|\s-w\b/.test(script) &&
    // fanning out to workspaces prints paths relative to each workspace,
    // which can't be mapped back; check those per workspace with --root
    !/--workspaces?\b|\bturbo\b|\bnx\b|\blerna\b/.test(script);
  const named = [
    ...TYPECHECK_SCRIPTS,
    ...Object.keys(scripts).filter(
      (n) => !TYPECHECK_SCRIPTS.includes(n) && /type-?check|tsc/i.test(n),
    ),
  ];
  for (const name of named) {
    const script = scripts[name];
    if (script && usable(script)) {
      return {
        command: runScriptCommand(findPackageManager(projectRoot), name),
        source: `package.json script "${name}": ${script}`,
      };
    }
  }

  const deps = directDependencies(projectRoot);
  // a solution tsconfig only type-checks through build mode; it may write
  // build output, which projects with references normally gitignore
  const hasTsconfig = existsSync(path.join(projectRoot, "tsconfig.json"));
  const args =
    hasTsconfig && tsconfigReferences(projectRoot).length > 0
      ? "-b --pretty false"
      : `--noEmit --pretty false${hasTsconfig ? " -p tsconfig.json" : ""}`;
  const candidates = [
    ...CHECKERS.filter((c) => c.pkg in deps),
    ...CHECKERS.filter((c) => !(c.pkg in deps)),
  ];
  // a checker the project declares but hasn't installed means a stale
  // install; falling back silently would check with a different compiler
  const missing = CHECKERS.filter(
    (c) => c.pkg in deps && !findBin(projectRoot, c.bin),
  ).map((c) => c.pkg);
  const warning =
    missing.length > 0
      ? `; WARNING: ${missing.join(", ")} declared in package.json but not installed. Run the package manager's install`
      : "";
  for (const checker of candidates) {
    const bin = findBin(projectRoot, checker.bin);
    if (bin) {
      return {
        command: `"${bin}" ${args}`,
        source: `${checker.name} from ${checker.pkg in deps ? "package.json" : "node_modules"}${warning}`,
      };
    }
  }

  throw new Error(
    "No type checker found. Install one (typescript, @typescript/native-preview, tsc-rs, vue-tsc), add a \"typecheck\" script, or pass --checker \"<command>\".",
  );
};

// Diagnostics look like either of
//   src/components/Component.tsx:231:33 - error TS2339: Property 'foo' does not exist on type 'Bar'
//   src/components/Component.tsx(231,33): error TS2339: Property 'foo' does not exist on type 'Bar'
// and may continue on following lines until the next diagnostic
const NEXT_ERROR = String.raw`(?!\S.*?(?::\d+:\d+ - |\(\d+,\d+\): )(?:error|warning) TS\d+)`;
const COLON_REGEX = new RegExp(
  String.raw`^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.*(?:\n${NEXT_ERROR}.*)*)`,
  "gm",
);
const BRACKET_REGEX = new RegExp(
  String.raw`^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*(?:\n${NEXT_ERROR}.*)*)`,
  "gm",
);

export const getBuildErrors = async (
  projectRoot: string,
  checker: Checker,
): Promise<BuildError[]> => {
  const result = await run(checker.command, { cwd: projectRoot });

  let output = `${result.stdout}\n${result.stderr}`.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    "",
  );
  const summary = /Found \d+ errors? in/;
  if (summary.test(output)) {
    output = output.substring(0, output.search(summary));
  }

  const items: BuildError[] = [];
  for (const regex of [COLON_REGEX, BRACKET_REGEX]) {
    for (const m of output.matchAll(regex)) {
      items.push({
        path: m[1]!.trim(),
        line: parseInt(m[2]!, 10),
        column: parseInt(m[3]!, 10),
        message: `${m[5]}: ${m[6]!.trim()}`,
      });
    }
  }

  // a failing checker with nothing we could parse means it didn't run
  // (not installed, bad tsconfig, unknown flag) rather than a clean build
  if (result.code !== 0 && items.length === 0) {
    throw new Error(
      `Type checker failed without reporting file errors.\ncommand: ${checker.command} (${checker.source})\n${output.trim().slice(-3000)}`,
    );
  }

  return items.filter((item) => !item.path.includes("node_modules/"));
};
