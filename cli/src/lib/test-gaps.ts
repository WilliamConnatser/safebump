import { readdirSync, readFileSync } from "fs";
import path from "path";
import type { Node as MorphNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind, ts } from "ts-morph";

import { isFromPackage } from "./typescript/ast";
import { initializeAst } from "./typescript/index";

// Which code using the upgraded packages no test reaches, found statically:
// a source file counts as covered when some test file imports it, directly
// or through other project files. Uncovered usages are where to write
// characterization tests on the old version before upgrading; they must pass
// before and after.

export type TestGapUsage = {
  line: number;
  // imported name as used: useQuery, OpenAI, z.object
  symbol: string;
  // the exported function/class to test it through
  enclosing: string;
};

export type TestGapFile = {
  file: string;
  packages: string[];
  covered: boolean;
  // nearest tests reaching the file, up to 3
  viaTests: string[];
  // every test reaching the file mocks the package (vi.mock/jest.mock): the
  // package's own behavior is never exercised
  mockedOnly: boolean;
  usages: TestGapUsage[];
};

export type TestGaps = {
  packages: string[];
  testFiles: number;
  files: TestGapFile[];
  summary: { files: number; covered: number; uncovered: number };
  notes: string[];
};

const CODE_FILE = /\.([cm]?[jt]sx?)$/;
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)__tests__\/)|((^|\/)tests?\/.*\.[cm]?tsx?$)/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "out", ".next", ".expo"]);
const CONFIG_FILE = /^(vitest|vite|jest)\.config\.[cm]?[jt]s$/;
// past this the monorepo is mostly other workspaces; stop following imports
const MAX_GRAPH_FILES = 20000;
const MAX_VIA = 3;
const MAX_REACHING = 50;

const rel = (projectRoot: string, file: string) => path.relative(projectRoot, file);

// ---- test files ----

const globToRegExp = (glob: string) => {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === ",") re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re.replace(/^\.\//, "")}$`);
};

// test.include (vitest) and testMatch (jest) globs; not coverage.include,
// which lists source files
const configGlobs = (projectRoot: string, project: Project) => {
  const globs: RegExp[] = [];
  const files = readdirSync(projectRoot).filter((f) => CONFIG_FILE.test(f));
  for (const f of files) {
    const sf = project.createSourceFile(
      path.join(projectRoot, `__safebump_config_${f}.ts`),
      readFileSync(path.join(projectRoot, f), "utf-8"),
      { overwrite: true },
    );
    for (const prop of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      const name = prop.getName().replace(/['"]/g, "");
      const owner = prop
        .getParentIfKind(SyntaxKind.ObjectLiteralExpression)
        ?.getParentIfKind(SyntaxKind.PropertyAssignment)
        ?.getName();
      const wanted = (name === "include" && owner === "test") || name === "testMatch";
      const array = prop.getInitializerIfKind(SyntaxKind.ArrayLiteralExpression);
      if (!wanted || !array) continue;
      for (const el of array.getElements()) {
        if (Node.isStringLiteral(el) || Node.isNoSubstitutionTemplateLiteral(el)) {
          globs.push(globToRegExp(el.getLiteralValue().replace(/^<rootDir>\//, "")));
        }
      }
    }
    project.removeSourceFile(sf);
  }
  return globs;
};

const walk = (dir: string, out: string[]) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (CODE_FILE.test(e.name) && !e.name.endsWith(".d.ts")) out.push(full);
  }
};

const findTestFiles = (projectRoot: string, project: Project) => {
  const globs = configGlobs(projectRoot, project);
  const files: string[] = [];
  walk(projectRoot, files);
  return files.filter((f) => {
    const r = rel(projectRoot, f);
    return TEST_FILE.test(r) || globs.some((g) => g.test(r));
  });
};

// ---- import graph ----

type Graph = {
  // file -> project files it imports (runtime imports only)
  edges: Map<string, string[]>;
  truncated: boolean;
};

const isTypeOnlyImport = (d: MorphNode) =>
  (Node.isImportDeclaration(d) && d.isTypeOnly()) ||
  (Node.isExportDeclaration(d) && d.isTypeOnly());

const runtimeSpecifiers = (sf: SourceFile) => {
  const specs: string[] = [];
  for (const d of [...sf.getImportDeclarations(), ...sf.getExportDeclarations()]) {
    const spec = d.getModuleSpecifierValue();
    if (spec && !isTypeOnlyImport(d)) specs.push(spec);
  }
  for (const d of sf.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
    const ref = d.getModuleReference();
    if (Node.isExternalModuleReference(ref)) {
      const e = ref.getExpression();
      if (e && Node.isStringLiteral(e)) specs.push(e.getLiteralValue());
    }
  }
  // import("x"), require("x"); skipped unless the text could contain one
  const text = sf.getFullText();
  if (text.includes("import(") || text.includes("require(")) {
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const isLoad =
        callee.getKind() === SyntaxKind.ImportKeyword ||
        (Node.isIdentifier(callee) && callee.getText() === "require");
      const arg = call.getArguments()[0];
      if (isLoad && arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
        specs.push(arg.getLiteralValue());
      }
    }
  }
  return specs;
};

const buildGraph = (project: Project, roots: string[]): Graph => {
  const options = project.getCompilerOptions();
  const cache = ts.createModuleResolutionCache(process.cwd(), (f) => f, options);
  const edges = new Map<string, string[]>();
  const queue = [...roots];
  let truncated = false;

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (edges.has(file)) continue;
    if (edges.size >= MAX_GRAPH_FILES) {
      truncated = true;
      break;
    }
    const sf = project.getSourceFile(file) ?? project.addSourceFileAtPathIfExists(file);
    const targets: string[] = [];
    edges.set(file, targets);
    if (!sf) continue;
    for (const spec of runtimeSpecifiers(sf)) {
      const resolved = ts.resolveModuleName(spec, file, options, ts.sys, cache).resolvedModule;
      if (!resolved || resolved.isExternalLibraryImport) continue;
      const target = path.normalize(resolved.resolvedFileName);
      if (target.includes("/node_modules/") || target.endsWith(".d.ts")) continue;
      targets.push(target);
      if (!edges.has(target)) queue.push(target);
    }
  }
  return { edges, truncated };
};

const reverse = (edges: Map<string, string[]>) => {
  const back = new Map<string, string[]>();
  for (const [from, tos] of edges) {
    for (const to of tos) back.set(to, [...(back.get(to) ?? []), from]);
  }
  return back;
};

// tests reaching `file`, nearest first
const reachingTests = (file: string, back: Map<string, string[]>, tests: Set<string>) => {
  const found: string[] = [];
  const seen = new Set([file]);
  const queue = [file];
  while (queue.length > 0 && found.length < MAX_REACHING) {
    const f = queue.shift()!;
    for (const importer of back.get(f) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      if (tests.has(importer)) found.push(importer);
      queue.push(importer);
    }
  }
  return found;
};

const MOCK = /\b(?:vi|jest)\.(?:mock|doMock|unstable_mockModule)\(\s*['"`]([^'"`]+)['"`]/g;

const mockedSpecifiers = (file: string) => {
  try {
    return Array.from(readFileSync(file, "utf-8").matchAll(MOCK), (m) => m[1]!);
  } catch {
    return [];
  }
};

// ---- usages ----

const topLevel = (node: MorphNode) => {
  let current = node;
  while (current.getParent() && !Node.isSourceFile(current.getParent()!)) current = current.getParent()!;
  return current;
};

const isExported = (statement: MorphNode) =>
  Node.isExportAssignment(statement) ||
  (Node.isExportable(statement) && statement.isExported());

const statementNames = (statement: MorphNode): string[] => {
  if (Node.isVariableStatement(statement)) return statement.getDeclarations().map((d) => d.getName());
  if (Node.isExportAssignment(statement)) return ["export default"];
  if (Node.isFunctionDeclaration(statement) || Node.isClassDeclaration(statement)) {
    return [statement.getName() ?? "default"];
  }
  return [];
};

const enclosingName = (node: MorphNode) => {
  const statement = topLevel(node);
  const ancestors = node.getAncestors();
  if (Node.isVariableStatement(statement)) {
    const decl = statement.getDeclarations().find((d) => ancestors.includes(d));
    return decl?.getName() ?? statementNames(statement)[0];
  }
  if (Node.isClassDeclaration(statement)) {
    const name = statement.getName() ?? "default";
    const member = ancestors.find((a) => a.getParent() === statement);
    if (member && Node.isConstructorDeclaration(member)) return `new ${name}`;
    const memberName =
      member && (Node.isMethodDeclaration(member) || Node.isPropertyDeclaration(member) || Node.isGetAccessorDeclaration(member))
        ? member.getName()
        : undefined;
    return memberName ? `${name}.${memberName}` : name;
  }
  return statementNames(statement)[0];
};

// the exported thing to test through: the enclosing declaration, or an
// exported one in the same file that uses it
const enclosingExport = (node: MorphNode, exportedUsers: (name: string) => string | undefined) => {
  const statement = topLevel(node);
  const name = enclosingName(node);
  if (!name) return "the module's top level (runs on import)";
  if (isExported(statement)) return name;
  const user = exportedUsers(name.split(".")[0]!);
  return user ? `${user} (via ${name})` : `${name} (not exported)`;
};

// top-level names in the file, followed through non-exported helpers
// (makeClient -> make -> export const Live) to the first exported user
const exportedUsersOf = (sf: SourceFile) => {
  const statements = sf.getStatements();
  const mentions = new Map(
    statements.map((s) => [s, new Set(s.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()))]),
  );
  return (name: string) => {
    const seen = new Set([name]);
    const queue = [name];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const s of statements) {
        const own = statementNames(s);
        if (own.includes(current) || !mentions.get(s)!.has(current)) continue;
        if (isExported(s)) return own[0];
        for (const n of own) {
          if (!seen.has(n)) {
            seen.add(n);
            queue.push(n);
          }
        }
      }
    }
    return undefined;
  };
};

// the identifier is a property name or a type, not a value reference
const isNonValue = (id: MorphNode) => {
  const parent = id.getParent();
  if (!parent) return true;
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) return true;
  if ((Node.isPropertyAssignment(parent) || Node.isPropertySignature(parent)) && parent.getNameNode() === id) return true;
  if (Node.isImportSpecifier(parent) || Node.isImportClause(parent) || Node.isNamespaceImport(parent)) return true;
  // </YStack> repeats <YStack>
  if (Node.isJsxClosingElement(parent)) return true;
  return !!id.getFirstAncestor((a) => Node.isTypeNode(a) && !Node.isExpressionWithTypeArguments(a));
};

const packageUsages = (sf: SourceFile, pkg: string): TestGapUsage[] => {
  // local name -> display name
  const locals = new Map<string, (id: MorphNode) => string>();
  const usages: TestGapUsage[] = [];
  const exportedUsers = exportedUsersOf(sf);

  for (const imp of sf.getImportDeclarations()) {
    if (imp.isTypeOnly() || !isFromPackage(imp.getModuleSpecifierValue(), pkg)) continue;
    for (const n of imp.getNamedImports()) {
      if (n.isTypeOnly()) continue;
      const imported = n.getName();
      locals.set(n.getAliasNode()?.getText() ?? imported, () => imported);
    }
    const dflt = imp.getDefaultImport()?.getText();
    if (dflt) locals.set(dflt, () => dflt);
    const ns = imp.getNamespaceImport()?.getText();
    if (ns) {
      locals.set(ns, (id) => {
        const parent = id.getParent();
        return Node.isPropertyAccessExpression(parent) && parent.getExpression() === id
          ? `${ns}.${parent.getName()}`
          : ns;
      });
    }
  }
  // `export { x } from "pkg"`: passed through, used wherever it's imported
  for (const exp of sf.getExportDeclarations()) {
    const spec = exp.getModuleSpecifierValue();
    if (!spec || exp.isTypeOnly() || !isFromPackage(spec, pkg)) continue;
    const names = exp.getNamedExports().map((e) => e.getName());
    usages.push({
      line: exp.getStartLineNumber(),
      symbol: names.length > 0 ? names.join(", ") : "*",
      enclosing: "re-export",
    });
  }
  if (locals.size === 0) return usages;

  const seen = new Set<string>();
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const display = locals.get(id.getText());
    if (!display || isNonValue(id)) continue;
    const symbol = display(id);
    const line = id.getStartLineNumber();
    const key = `${line}:${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    usages.push({ line, symbol, enclosing: enclosingExport(id, exportedUsers) });
  }
  return usages;
};

// ---- putting it together ----

export const findTestGaps = (projectRoot: string, pkgs: string[]): TestGaps => {
  const root = path.resolve(projectRoot);
  const project = initializeAst(root);
  const notes: string[] = [];

  const tests = findTestFiles(root, project).map((f) => path.normalize(f));
  const testSet = new Set(tests);
  if (tests.length === 0) notes.push("No test files found: every usage is uncovered.");

  // usages first: only files inside the project root that use the packages
  const using: { sf: SourceFile; file: string; packages: string[]; usages: TestGapUsage[] }[] = [];
  for (const sf of project.getSourceFiles()) {
    const file = path.normalize(sf.getFilePath());
    if (sf.isInNodeModules() || sf.isDeclarationFile() || testSet.has(file)) continue;
    if (!file.startsWith(root + path.sep)) continue;
    const usedPkgs: string[] = [];
    const usages: TestGapUsage[] = [];
    for (const pkg of pkgs) {
      const found = packageUsages(sf, pkg);
      if (found.length === 0) continue;
      usedPkgs.push(pkg);
      usages.push(...found);
    }
    if (usages.length > 0) {
      using.push({ sf, file, packages: usedPkgs, usages: usages.sort((a, b) => a.line - b.line) });
    }
  }

  const graph = buildGraph(project, tests);
  if (graph.truncated) {
    notes.push(`Import graph capped at ${MAX_GRAPH_FILES} files; some files may be reported uncovered wrongly.`);
  }
  const back = reverse(graph.edges);
  const mocks = new Map<string, string[]>();
  const mocksAny = (test: string, used: string[]) => {
    if (!mocks.has(test)) mocks.set(test, mockedSpecifiers(test));
    return mocks.get(test)!.some((spec) => used.some((p) => isFromPackage(spec, p)));
  };

  const files: TestGapFile[] = using.map(({ file, packages, usages }) => {
    const reaching = graph.edges.has(file) ? reachingTests(file, back, testSet) : [];
    return {
      file: rel(root, file),
      packages,
      covered: reaching.length > 0,
      viaTests: reaching.slice(0, MAX_VIA).map((t) => rel(root, t)),
      mockedOnly: reaching.length > 0 && reaching.every((t) => mocksAny(t, packages)),
      usages,
    };
  });

  // uncovered first, the heaviest users of the package first
  files.sort(
    (a, b) =>
      Number(a.covered) - Number(b.covered) ||
      b.usages.length - a.usages.length ||
      a.file.localeCompare(b.file),
  );
  const covered = files.filter((f) => f.covered).length;
  return {
    packages: pkgs,
    testFiles: tests.length,
    files,
    summary: { files: files.length, covered, uncovered: files.length - covered },
    notes,
  };
};

// ---- text output ----

const MAX_PRINTED_FILES = 25;
const MAX_PRINTED_TARGETS = 5;

const VIA = /^(.*) \(via (.*)\)$/;

// usages grouped by the exported thing to test, with the helpers they go through
const byTarget = (usages: TestGapUsage[]) => {
  const groups = new Map<string, { usages: TestGapUsage[]; helpers: Set<string> }>();
  for (const u of usages) {
    const m = VIA.exec(u.enclosing);
    const target = m ? m[1]! : u.enclosing;
    const g = groups.get(target) ?? { usages: [], helpers: new Set<string>() };
    g.usages.push(u);
    if (m) g.helpers.add(m[2]!);
    groups.set(target, g);
  }
  return [...groups].sort(([, a], [, b]) => b.usages.length - a.usages.length);
};

const list = (xs: string[], max: number) =>
  `${xs.slice(0, max).join(", ")}${xs.length > max ? `, … (+${xs.length - max})` : ""}`;

export const printTestGaps = (r: TestGaps) => {
  const { files, covered, uncovered } = r.summary;
  console.log(`# Test gaps: ${r.packages.join(", ")}`);
  console.log(
    `${files} file(s) use the package(s): ${covered} reached by tests, ${uncovered} not (${r.testFiles} test file(s) found).`,
  );
  for (const n of r.notes) console.log(`note: ${n}`);

  const gaps = r.files.filter((f) => !f.covered);
  if (gaps.length > 0) {
    console.log(`\n## Uncovered: write characterization tests on the current version first`);
    console.log(`They must pass before the upgrade and after it.`);
    for (const f of gaps.slice(0, MAX_PRINTED_FILES)) {
      console.log(`\n### ${f.file} (${f.usages.length} usage(s) of ${f.packages.join(", ")})`);
      const targets = byTarget(f.usages);
      for (const [target, g] of targets.slice(0, MAX_PRINTED_TARGETS)) {
        const symbols = Array.from(new Set(g.usages.map((u) => u.symbol)));
        const helpers = g.helpers.size > 0 ? `; through ${list([...g.helpers], 4)}` : "";
        console.log(`- write a characterization test for ${target} (${f.file})`);
        console.log(`    ${g.usages.length} usage(s): ${list(symbols, 8)} from line ${g.usages[0]!.line}${helpers}`);
      }
      if (targets.length > MAX_PRINTED_TARGETS) {
        console.log(`- (+${targets.length - MAX_PRINTED_TARGETS} more targets; --json for all)`);
      }
    }
    if (gaps.length > MAX_PRINTED_FILES) {
      const rest = gaps.slice(MAX_PRINTED_FILES);
      console.log(`\n(+${rest.length} more uncovered file(s): ${list(rest.map((f) => f.file), 10)}; --json for all)`);
    }
  }

  const reached = r.files.filter((f) => f.covered);
  if (reached.length > 0) {
    console.log(`\n## Reached by tests`);
    for (const f of reached) {
      const mocked = f.mockedOnly ? ` (every reaching test mocks ${f.packages.join("/")}: its behavior isn't exercised)` : "";
      console.log(`- ${f.file} (${f.usages.length} usage(s)) via ${f.viaTests.join(", ")}${mocked}`);
    }
  }
};
