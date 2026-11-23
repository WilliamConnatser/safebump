import path from "path";
import type { SourceFile } from "ts-morph";
import { Node, ts } from "ts-morph";

import { packageOf } from "./fetch-package";
import { readPackageJson } from "./packages";
import { findPackageDir } from "./typescript/analyze";
import { isFromPackage } from "./typescript/ast";
import { initializeAst } from "./typescript/index";

// Uses of APIs a package marks @deprecated. Run on the latest release of the
// current major before a major bump: what it deprecates is usually what the
// next major removes, and the deprecation text names the replacement.

// "'{0}' is deprecated." and "The signature '{0}' of '{1}' is deprecated."
const DEPRECATED_CODES = new Set([6385, 6387]);

export type DeprecatedUse = {
  // relative to the project root
  file: string;
  line: number;
  column: number;
  // e.g. "QueryObserverResult.isLoading"
  symbol: string;
  // the requested package this API belongs to
  package: string;
  // the package whose declaration carries the tag, when it differs
  // (e.g. @tanstack/query-core for @tanstack/react-query)
  declaredIn: string;
  // the @deprecated tag text; usually names the replacement
  message: string;
  code: number;
};

export type DeprecationReport = {
  packages: string[];
  uses: DeprecatedUse[];
  byPackage: Record<string, number>;
  filesScanned: number;
};

// "<root>/node_modules/.pnpm/x/node_modules/@s/p/dist/a.d.ts" -> "@s/p";
// "@types/s__p" -> "@s/p"
const packageFromPath = (file: string) => {
  const idx = file.lastIndexOf("/node_modules/");
  if (idx === -1) return undefined;
  const name = packageOf(file.slice(idx + "/node_modules/".length));
  if (!name.startsWith("@types/")) return name;
  const bare = name.slice("@types/".length);
  return bare.includes("__") ? `@${bare.replace("__", "/")}` : bare;
};

// packages that ship part of `pkg`'s API: its dependencies in the same scope
// or named after it (query-core for react-query, @tamagui/* for tamagui,
// expo-* and @expo/* for expo, @react-native/* for react-native)
const packageFamily = (projectRoot: string, pkg: string) => {
  const dir = findPackageDir(projectRoot, pkg);
  const manifest = dir
    ? (readPackageJson(dir) as { dependencies?: Record<string, string> })
    : undefined;
  const scope = pkg.startsWith("@") ? pkg.split("/")[0] : undefined;
  const related = (dep: string) =>
    scope
      ? dep.startsWith(`${scope}/`)
      : dep.startsWith(`${pkg}-`) || dep.startsWith(`@${pkg}/`);
  return [pkg, ...Object.keys(manifest?.dependencies ?? {}).filter(related)];
};

const importsAny = (sourceFile: SourceFile, names: string[]) =>
  sourceFile
    .getImportStringLiterals()
    .some((lit) => names.some((n) => isFromPackage(lit.getLiteralValue(), n)));

const jsDocText = (comment: string | ts.SymbolDisplayPart[] | undefined) =>
  (typeof comment === "string" ? comment : ts.displayPartsToString(comment))
    .replace(/\s+/g, " ")
    .trim();

const deprecatedTag = (tags: ts.JSDocTagInfo[]) => {
  const tag = tags.find((t) => t.name === "deprecated");
  return tag ? jsDocText(tag.text) : undefined;
};

// strips the quoted module prefix: "\"/abs/node_modules/x/index\".Foo.bar" ->
// "Foo.bar"; properties seen through mapped types (Omit<Options, ...>) are
// synthetic and unqualified, so they borrow the owner from their declaration
const displayName = (checker: ts.TypeChecker, symbol: ts.Symbol) => {
  const name = checker.getFullyQualifiedName(symbol).replace(/^".*?"\./, "");
  if (name.includes(".")) return name;
  const parent = symbol.getDeclarations()?.[0]?.parent;
  const owner =
    parent && (ts.isInterfaceDeclaration(parent) || ts.isClassLike(parent))
      ? parent.name?.text
      : parent && ts.isTypeLiteralNode(parent) && ts.isTypeAliasDeclaration(parent.parent)
        ? parent.parent.name.text
        : undefined;
  return owner ? `${owner}.${name}` : name;
};

type Target = { symbol: string; declarations: ts.Declaration[]; message?: string };

// the deprecated thing at a diagnostic: a signature for 6387, else the symbol
// (seen through import aliases, and through object literal keys to the
// property of the contextual type, e.g. a deprecated option)
const resolveTarget = (
  checker: ts.TypeChecker,
  node: Node,
  code: number,
): Target | undefined => {
  const compilerNode = node.compilerNode;
  let symbol = checker.getSymbolAtLocation(compilerNode);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const parent = compilerNode.parent;
  if (
    parent &&
    (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) &&
    parent.name === compilerNode &&
    ts.isObjectLiteralExpression(parent.parent)
  ) {
    const contextual = checker
      .getContextualType(parent.parent)
      ?.getProperty(compilerNode.getText());
    if (contextual) symbol = contextual;
  }

  if (code === 6387) {
    // the diagnostic sits on the callee, so the nearest call-like ancestor
    // is the call whose resolved signature is deprecated
    const call = node
      .getAncestors()
      .find((a) => ts.isCallLikeExpression(a.compilerNode));
    const signature =
      call &&
      checker.getResolvedSignature(call.compilerNode as ts.CallLikeExpression);
    const declaration = signature?.getDeclaration();
    if (signature && declaration) {
      return {
        symbol: symbol ? displayName(checker, symbol) : node.getText(),
        declarations: [declaration],
        message: deprecatedTag(signature.getJsDocTags()),
      };
    }
  }

  if (!symbol) return undefined;
  return {
    symbol: displayName(checker, symbol),
    declarations: symbol.getDeclarations() ?? [],
    message: deprecatedTag(symbol.getJsDocTags(checker)),
  };
};

// options are usually optional parameters, so the contextual type is
// `Options | undefined`, and unions only have properties all members share
const contextualProperty = (
  checker: ts.TypeChecker,
  owner: ts.Expression,
  name: string,
) => {
  const type = checker.getContextualType(owner);
  if (!type) return undefined;
  const members = type.isUnion() ? type.types : [type];
  for (const member of members) {
    const property = checker.getNonNullableType(member).getProperty(name);
    if (property) return property;
  }
  return undefined;
};

type Site = { start: number; code: number; target: Target };

const diagnosticSites = (
  service: ts.LanguageService,
  checker: ts.TypeChecker,
  sourceFile: SourceFile,
): Site[] => {
  const sites: Site[] = [];
  for (const d of service.getSuggestionDiagnostics(sourceFile.getFilePath())) {
    if (!DEPRECATED_CODES.has(d.code) || d.start === undefined) continue;
    const node = sourceFile.getDescendantAtPos(d.start);
    // the import of a deprecated name is flagged too; the fix happens at
    // the use sites, which are reported separately
    if (!node || node.getFirstAncestorByKind(ts.SyntaxKind.ImportDeclaration)) {
      continue;
    }
    const target = resolveTarget(checker, node, d.code);
    if (target) sites.push({ start: d.start, code: d.code, target });
  }
  return sites;
};

// TypeScript only flags deprecated members on access, not when an object
// literal or JSX attribute sets them, yet deprecated options (`onSuccess` in
// useQuery's options, a component prop) are the most common case
const literalKeySites = (
  checker: ts.TypeChecker,
  sourceFile: SourceFile,
): Site[] => {
  const sites: Site[] = [];
  const visit = (node: ts.Node) => {
    let owner: ts.Expression | undefined;
    let key: ts.Node | undefined;
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isMethodDeclaration(node)) &&
      ts.isObjectLiteralExpression(node.parent)
    ) {
      owner = node.parent;
      key = node.name;
    } else if (ts.isJsxAttribute(node)) {
      owner = node.parent;
      key = node.name;
    }
    // computed keys can't be looked up statically
    const name =
      key && (ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key))
        ? key.text
        : undefined;
    if (owner && key && name !== undefined) {
      const property = contextualProperty(checker, owner, name);
      const message = property && deprecatedTag(property.getJsDocTags(checker));
      if (property && message !== undefined) {
        sites.push({
          start: key.getStart(sourceFile.compilerNode),
          code: 6385,
          target: {
            symbol: displayName(checker, property),
            declarations: property.getDeclarations() ?? [],
            message,
          },
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile.compilerNode);
  return sites;
};

export const findDeprecations = (
  projectRoot: string,
  pkgs: string[],
): DeprecationReport => {
  // each family member maps back to the package the user asked about
  const owner = new Map<string, string>();
  for (const pkg of pkgs) {
    for (const member of packageFamily(projectRoot, pkg)) {
      if (!owner.has(member)) owner.set(member, pkg);
    }
  }
  const importable = Array.from(owner.keys());

  const project = initializeAst(projectRoot);
  const service = project.getLanguageService().compilerObject;
  // the language service's own program, so the project isn't type-checked
  // twice (a second checker doubles memory); it shares ts-morph's parsed
  // source files, so ts-morph nodes resolve against it
  const checker = service.getProgram()!.getTypeChecker();
  const uses: DeprecatedUse[] = [];
  let filesScanned = 0;
  const inProject = `${path.resolve(projectRoot)}${path.sep}`;
  for (const sourceFile of project.getSourceFiles()) {
    // other workspaces reached through imports or `paths` are reported when
    // safebump runs on them; only files importing the package can use its
    // API (barring globals)
    if (
      sourceFile.isInNodeModules() ||
      !sourceFile.getFilePath().startsWith(inProject) ||
      !importsAny(sourceFile, importable)
    ) {
      continue;
    }
    filesScanned++;
    const filePath = sourceFile.getFilePath();
    const sites = [
      ...diagnosticSites(service, checker, sourceFile),
      ...literalKeySites(checker, sourceFile),
    ];
    // a deprecated overload is reported as both 6385 and 6387 at one spot
    const seen = new Set<number>();
    for (const { start, code, target } of sites.sort((a, b) => b.code - a.code)) {
      if (seen.has(start)) continue;
      const declaredIn = target.declarations
        .map((decl) => packageFromPath(decl.getSourceFile().fileName))
        .find((p) => p && owner.has(p));
      if (!declaredIn) continue;
      seen.add(start);

      const { line, character } = ts.getLineAndCharacterOfPosition(
        sourceFile.compilerNode,
        start,
      );
      uses.push({
        file: path.relative(projectRoot, filePath),
        line: line + 1,
        column: character + 1,
        symbol: target.symbol,
        package: owner.get(declaredIn)!,
        declaredIn,
        message: target.message || `'${target.symbol}' is deprecated.`,
        code,
      });
    }
  }
  uses.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );

  const byPackage: Record<string, number> = Object.fromEntries(
    pkgs.map((p) => [p, 0]),
  );
  for (const u of uses) byPackage[u.package] = (byPackage[u.package] ?? 0) + 1;
  return { packages: pkgs, uses, byPackage, filesScanned };
};

export const printDeprecations = (r: DeprecationReport) => {
  if (r.uses.length === 0) {
    console.log(
      `No uses of APIs deprecated by ${r.packages.join(", ")} (${r.filesScanned} importing file(s) checked).`,
    );
    return;
  }
  console.log(
    `${r.uses.length} use(s) of deprecated APIs in ${r.filesScanned} importing file(s): ${Object.entries(r.byPackage)
      .map(([p, n]) => `${p} ${n}`)
      .join(", ")}`,
  );
  console.log(
    "Fix these on the current major before bumping: the next major usually removes them.",
  );

  const groups = new Map<string, DeprecatedUse[]>();
  for (const u of r.uses) {
    const key = `${u.declaredIn}\0${u.symbol}\0${u.message}`;
    groups.set(key, [...(groups.get(key) ?? []), u]);
  }
  const sorted = Array.from(groups.values()).sort((a, b) => b.length - a.length);
  for (const group of sorted) {
    const first = group[0]!;
    const from = first.declaredIn === first.package
      ? first.package
      : `${first.package} via ${first.declaredIn}`;
    console.log(`\n## ${first.symbol} (${from}) — ${group.length} use(s)`);
    console.log(`   ${first.message}`);
    for (const u of group) console.log(`- ${u.file}:${u.line}:${u.column}`);
  }
};
