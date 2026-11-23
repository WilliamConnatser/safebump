import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";

import type { BuildError } from "../types";
import type { Block } from "./ast";
import {
  blockAt,
  isFromPackage,
  packageImportsUsed,
  referencingBlocks,
} from "./ast";
import type { Checker } from "../checker";
import { getBuildErrors } from "../checker";
import { initializeAst } from "./index";
import type { Node as MorphNode } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

export type ErrorBlock = Omit<Block, "node" | "path"> & {
  errors: BuildError[];
  usesPackage: string[];
  // ids of other error blocks this block references; fix those first
  dependsOn: string[];
};

export type ErrorAnalysis = {
  totalErrors: number;
  phase: "package" | "other";
  // blocks for the current phase, in the order they should be fixed
  blocks: ErrorBlock[];
  // files grouped so that each wave only depends on earlier waves; files
  // within a wave can be fixed in parallel
  waves: { files: string[] }[];
  deferredBlocks: number;
  unmapped: BuildError[];
  // the same error at many sites: a candidate for one codemod instead of
  // many hand edits
  repeated: { message: string; count: number; files: string[] }[];
};

const REPEAT_THRESHOLD = 5;

const findRepeated = (errors: BuildError[]) => {
  const groups = new Map<string, { count: number; files: Set<string> }>();
  for (const e of errors) {
    const g = groups.get(e.message) ?? { count: 0, files: new Set<string>() };
    g.count++;
    g.files.add(e.path);
    groups.set(e.message, g);
  }
  return Array.from(groups.entries())
    .filter(([, g]) => g.count >= REPEAT_THRESHOLD)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([message, g]) => ({
      message,
      count: g.count,
      files: Array.from(g.files),
    }));
};

const fileWaves = (blocks: ErrorBlock[]) => {
  const blockFile = new Map(blocks.map((b) => [b.id, b.relPath]));
  const fileDeps = new Map<string, Set<string>>();
  for (const b of blocks) {
    const deps = fileDeps.get(b.relPath) ?? new Set<string>();
    for (const d of b.dependsOn) {
      const f = blockFile.get(d);
      if (f && f !== b.relPath) deps.add(f);
    }
    fileDeps.set(b.relPath, deps);
  }

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (file: string): number => {
    const known = depth.get(file);
    if (known !== undefined) return known;
    // cycles between files: treat the back edge as absent
    if (visiting.has(file)) return -1;
    visiting.add(file);
    let d = 0;
    for (const dep of fileDeps.get(file) ?? []) d = Math.max(d, visit(dep) + 1);
    visiting.delete(file);
    depth.set(file, d);
    return d;
  };

  const waves: { files: string[] }[] = [];
  for (const file of fileDeps.keys()) {
    const d = visit(file);
    (waves[d] ??= { files: [] }).files.push(file);
  }
  return waves.filter(Boolean);
};

const orderBlocks = (blocks: ErrorBlock[]) => {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const ordered: ErrorBlock[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (b: ErrorBlock) => {
    if (done.has(b.id) || visiting.has(b.id)) return;
    visiting.add(b.id);
    for (const dep of b.dependsOn) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    visiting.delete(b.id);
    done.add(b.id);
    ordered.push(b);
  };
  [...blocks]
    .sort(
      (a, b) =>
        a.relPath.localeCompare(b.relPath) || a.startLine - b.startLine,
    )
    .forEach(visit);
  return ordered;
};

export const analyzeErrors = async (
  projectRoot: string,
  pkgs: string[],
  checker: Checker,
): Promise<ErrorAnalysis> => {
  const errors = await getBuildErrors(projectRoot, checker);
  const empty: ErrorAnalysis = {
    totalErrors: 0,
    phase: "package",
    blocks: [],
    waves: [],
    deferredBlocks: 0,
    unmapped: [],
    repeated: [],
  };
  if (errors.length === 0) return empty;

  const project = initializeAst(projectRoot);
  const blocks = new Map<string, Block & { errors: BuildError[] }>();
  const unmapped: BuildError[] = [];

  for (const err of errors) {
    const abs = path.resolve(projectRoot, err.path);
    const sourceFile =
      project.getSourceFile(abs) ?? project.addSourceFileAtPathIfExists(abs);
    const block =
      sourceFile && blockAt(projectRoot, sourceFile, err.line, err.column);
    if (!block) {
      unmapped.push(err);
      continue;
    }
    const existing = blocks.get(block.id);
    if (existing) existing.errors.push(err);
    else blocks.set(block.id, { ...block, errors: [err] });
  }

  const withUsage = Array.from(blocks.values()).map((b) => ({
    ...b,
    usesPackage: pkgs.flatMap((pkg) => packageImportsUsed(b, pkg)),
  }));

  // errors in code touching the bumped packages are fixed first; the rest are
  // often knock-on errors that disappear once those are fixed
  const packageBlocks = withUsage.filter((b) => b.usesPackage.length > 0);
  const phase = packageBlocks.length > 0 ? "package" : "other";
  const current = phase === "package" ? packageBlocks : withUsage;
  const currentIds = new Set(current.map((b) => b.id));

  const dependsOn = new Map<string, Set<string>>();
  for (const b of current) {
    for (const ref of referencingBlocks(projectRoot, b)) {
      if (!currentIds.has(ref.id)) continue;
      const deps = dependsOn.get(ref.id) ?? new Set<string>();
      deps.add(b.id);
      dependsOn.set(ref.id, deps);
    }
  }

  const errorBlocks: ErrorBlock[] = current.map(
    ({ node: _node, path: _path, ...b }) => ({
      ...b,
      dependsOn: Array.from(dependsOn.get(b.id) ?? []),
    }),
  );

  return {
    totalErrors: errors.length,
    phase,
    blocks: orderBlocks(errorBlocks),
    waves: fileWaves(errorBlocks),
    deferredBlocks: withUsage.length - current.length,
    unmapped,
    repeated: findRepeated(errors),
  };
};

export const findPackageDir = (projectRoot: string, pkg: string) => {
  let dir = projectRoot;
  while (true) {
    const candidate = path.join(dir, "node_modules", pkg);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

export const DOC_FILE = /^(changelog|history|changes|releases|migrat|upgrad|breaking)/i;

export type ApiSymbol = {
  name: string;
  module: string;
  importedAt: string[];
  // the module resolved but no longer exports this name
  missing: boolean;
  signature: string;
};

export type ApiReport = {
  package: string;
  version?: string;
  repository?: string;
  homepage?: string;
  docs: string[];
  unresolvedModules: string[];
  symbols: ApiSymbol[];
  moduleExports: Record<string, string[]>;
  // type aliases/interfaces referenced by the signatures, deduplicated
  types: Record<string, string>;
};

export const repositoryUrl = (repo: unknown) => {
  const url =
    typeof repo === "string"
      ? repo
      : (repo as { url?: string } | undefined)?.url;
  return url
    ?.replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^github:/, "https://github.com/");
};

const MAX_TEXT = 1500;

export const clip = (text: string) =>
  text.length > MAX_TEXT
    ? `${text.slice(0, MAX_TEXT)}\n[... truncated, see the package's .d.ts files]`
    : text;

// declaration text without implementation bodies
export const declarationText = (decl: MorphNode): string => {
  if (Node.isClassDeclaration(decl)) {
    const ctors = decl
      .getConstructors()
      .map((c) => `  constructor(${c.getParameters().map((p) => p.getText()).join(", ")});`);
    const members = decl
      .getMembers()
      .filter((m) => !Node.isConstructorDeclaration(m))
      .map((m) => ("getName" in m && typeof m.getName === "function" ? (m.getName() as string) : ""))
      .filter(Boolean);
    return [
      `class ${decl.getName() ?? ""} {`,
      ...ctors,
      `  // members: ${Array.from(new Set(members)).join(", ")}`,
      `}`,
    ].join("\n");
  }
  if (Node.isVariableDeclaration(decl)) {
    const typeText =
      decl.getTypeNode()?.getText() ?? decl.getType().getText(decl);
    return `const ${decl.getName()}: ${typeText}`;
  }
  const body = decl.getFirstChildByKind(SyntaxKind.Block);
  const text = decl.getText();
  return body ? text.replace(body.getText(), "").trim() : text;
};

// type aliases and interfaces from node_modules referenced directly by `decl`
const referencedTypes = (decl: MorphNode, out: Map<string, string>) => {
  for (const ref of decl.getDescendantsOfKind(SyntaxKind.TypeReference)) {
    const name = ref.getTypeName().getText();
    if (out.has(name)) continue;
    const id = ref.getTypeName();
    const defs = Node.isIdentifier(id) ? id.getDefinitionNodes() : [];
    for (const def of defs) {
      const file = def.getSourceFile().getFilePath();
      if (!file.includes("/node_modules/") || file.includes("/node_modules/typescript/")) {
        continue;
      }
      if (Node.isTypeAliasDeclaration(def) || Node.isInterfaceDeclaration(def)) {
        out.set(name, clip(def.getText()));
      }
    }
  }
};

const resolveSignature = (
  identifier: MorphNode,
  types: Map<string, string>,
) => {
  let symbol = identifier.getSymbol();
  if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol() ?? symbol;
  const decls = symbol?.getDeclarations() ?? [];
  decls.forEach((d) => referencedTypes(d, types));
  return clip(decls.map(declarationText).join("\n"));
};

export const describeApi = (
  projectRoot: string,
  pkg: string,
  only?: string[],
): ApiReport => {
  const pkgDir = findPackageDir(projectRoot, pkg);
  const meta = pkgDir
    ? (JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf-8")) as {
        version?: string;
        repository?: unknown;
        homepage?: string;
      })
    : {};
  const docs = pkgDir
    ? readdirSync(pkgDir)
        .filter((f) => DOC_FILE.test(f))
        .map((f) => path.join(pkgDir, f))
    : [];

  const project = initializeAst(projectRoot);
  const symbols = new Map<string, ApiSymbol>();
  const moduleExports: Record<string, string[]> = {};
  const unresolved = new Set<string>();
  const types = new Map<string, string>();

  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isInNodeModules()) continue;
    for (const imp of sourceFile.getImportDeclarations()) {
      const specifier = imp.getModuleSpecifierValue();
      if (!isFromPackage(specifier, pkg)) continue;

      const moduleFile = imp.getModuleSpecifierSourceFile();
      if (!moduleFile) {
        unresolved.add(specifier);
      } else if (!moduleExports[specifier]) {
        moduleExports[specifier] = Array.from(
          moduleFile.getExportedDeclarations().keys(),
        ).sort();
      }
      const exported = moduleExports[specifier];

      const imported = [
        ...imp.getNamedImports().map((n) => ({
          name: n.getName(),
          identifier: n.getNameNode() as MorphNode,
        })),
        ...(imp.getDefaultImport()
          ? [{ name: "default", identifier: imp.getDefaultImport()! as MorphNode }]
          : []),
      ];

      for (const { name, identifier } of imported) {
        if (only && !only.includes(name)) continue;
        const key = `${specifier}#${name}`;
        const site = `${path.relative(projectRoot, sourceFile.getFilePath())}:${imp.getStartLineNumber()}`;
        const existing = symbols.get(key);
        if (existing) {
          existing.importedAt.push(site);
          continue;
        }
        const missing = !!exported && !exported.includes(name);
        const signature = missing ? "" : resolveSignature(identifier, types);
        symbols.set(key, {
          name,
          module: specifier,
          importedAt: [site],
          missing,
          signature,
        });
      }
    }
  }

  return {
    package: pkg,
    version: meta.version,
    repository: repositoryUrl(meta.repository),
    homepage: meta.homepage,
    docs,
    unresolvedModules: Array.from(unresolved),
    symbols: Array.from(symbols.values()).sort(
      (a, b) => Number(b.missing) - Number(a.missing),
    ),
    moduleExports,
    types: Object.fromEntries(types),
  };
};

export const findReferences = (
  projectRoot: string,
  file: string,
  line: number,
) => {
  const project = initializeAst(projectRoot);
  const abs = path.resolve(projectRoot, file);
  const sourceFile =
    project.getSourceFile(abs) ?? project.addSourceFileAtPathIfExists(abs);
  if (!sourceFile) throw new Error(`File not found: ${abs}`);

  const text = sourceFile.getFullText().split("\n")[line - 1] ?? "";
  const column = text.length - text.trimStart().length + 1;
  const block = blockAt(projectRoot, sourceFile, line, column);
  if (!block) throw new Error(`No code block at ${file}:${line}`);

  return {
    block: { id: block.id, name: block.name, kind: block.kind },
    references: referencingBlocks(projectRoot, block).map(
      ({ node, path: _path, ...b }) => ({ ...b, text: node.getText() }),
    ),
  };
};
