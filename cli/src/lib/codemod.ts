import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { pathToFileURL } from "url";
import type { Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind, ts } from "ts-morph";

import { run } from "./subprocess";
import { initializeAst } from "./typescript/index";

// Everything a transform needs is passed in, so a transform file can live
// anywhere (the project, a scratch dir) without resolving ts-morph itself.
export type CodemodApi = {
  project: Project;
  Node: typeof Node;
  SyntaxKind: typeof SyntaxKind;
  ts: typeof ts;
};

export type Transform = (
  file: SourceFile,
  api: CodemodApi,
) => boolean | void | Promise<boolean | void>;

export type CodemodResult = {
  transform: string;
  dryRun: boolean;
  filesScanned: number;
  changed: { file: string; diff?: string }[];
  failed: { file: string; error: string }[];
};

const unifiedDiff = async (file: string, before: string, after: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), "safebump-codemod-"));
  const a = path.join(dir, "before");
  const b = path.join(dir, "after");
  writeFileSync(a, before);
  writeFileSync(b, after);
  const { stdout } = await run(
    `diff -u --label "a/${file}" --label "b/${file}" "${a}" "${b}"`,
    { cwd: dir },
  );
  return stdout;
};

// The bundled CLI runs on plain Node, which can't import .ts files on every
// version we support, so transforms are transpiled with the bundled
// TypeScript first. Type-only imports (like the template's) are erased.
const compileTransform = async (transformPath: string) => {
  const source = path.resolve(transformPath);
  if (!/\.[cm]?tsx?$/.test(source)) return source;
  const { outputText } = ts.transpileModule(readFileSync(source, "utf-8"), {
    fileName: source,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  });
  const out = path.join(
    mkdtempSync(path.join(tmpdir(), "safebump-transform-")),
    `${path.basename(source).replace(/\.[cm]?tsx?$/, "")}.mjs`,
  );
  writeFileSync(out, outputText);
  return out;
};

export const runCodemod = async (
  projectRoot: string,
  transformPath: string,
  options: { dryRun: boolean; filter?: string; maxDiffs?: number },
): Promise<CodemodResult> => {
  const mod = (await import(
    pathToFileURL(await compileTransform(transformPath)).href
  )) as { default?: Transform };
  const transform = mod.default;
  if (typeof transform !== "function") {
    throw new Error(
      `${transformPath} must export default a function (file, api) => boolean`,
    );
  }

  const project = initializeAst(projectRoot);
  const filter = options.filter ? new RegExp(options.filter) : undefined;
  const files = project
    .getSourceFiles()
    .filter((f) => !f.isInNodeModules() && !f.isDeclarationFile())
    .filter((f) => !filter || filter.test(f.getFilePath()));

  const api: CodemodApi = { project, Node, SyntaxKind, ts };
  const result: CodemodResult = {
    transform: transformPath,
    dryRun: options.dryRun,
    filesScanned: files.length,
    changed: [],
    failed: [],
  };

  for (const file of files) {
    const rel = path.relative(projectRoot, file.getFilePath());
    const before = file.getFullText();
    try {
      await transform(file, api);
    } catch (e) {
      result.failed.push({
        file: rel,
        error: e instanceof Error ? e.message : String(e),
      });
      file.replaceWithText(before);
      continue;
    }
    const after = file.getFullText();
    if (after === before) continue;

    const showDiff = result.changed.length < (options.maxDiffs ?? 5);
    result.changed.push({
      file: rel,
      diff: options.dryRun && showDiff ? await unifiedDiff(rel, before, after) : undefined,
    });
    if (!options.dryRun) await file.save();
  }
  return result;
};

export const printCodemod = (r: CodemodResult) => {
  console.log(
    `${r.dryRun ? "[dry run] " : ""}${r.changed.length} of ${r.filesScanned} files ${r.dryRun ? "would change" : "changed"}.`,
  );
  for (const c of r.changed) {
    console.log(c.diff ? `\n${c.diff}` : `- ${c.file}`);
  }
  if (r.dryRun && r.changed.some((c) => !c.diff)) {
    console.log(
      `\n(diffs shown for the first files only; others: ${r.changed.filter((c) => !c.diff).map((c) => c.file).join(", ")})`,
    );
  }
  if (r.failed.length > 0) {
    console.log(`\n## Transform threw on ${r.failed.length} file(s), left unchanged`);
    for (const f of r.failed) console.log(`- ${f.file}: ${f.error}`);
  }
};
