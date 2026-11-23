import path from "path";
import { ts } from "ts-morph";
import type { SourceFile } from "ts-morph";

import { packageOf } from "../fetch-package";
import { readPackageJson } from "../packages";
import { findPackageDir } from "./analyze";
import { isFromPackage } from "./ast";
import { initializeAst } from "./index";

// Which parts of a package's API the project actually touches, down to
// members reached through instances and return values
// (`client.responses.create`, `const { data } = useQuery(...)`) and the
// option keys it sets, so an upgrade review can be scoped to that surface.
// Members are attributed by where the checker says they're declared, not by
// name, so `data` on an unrelated object doesn't count.

export type ApiUseKind = "import" | "call" | "new" | "property" | "option" | "jsx" | "type";

export type ApiUse = {
  // "OpenAI", "Responses.create", "UseQueryResult.data"
  api: string;
  // declaring interface/class/alias/namespace; undefined for top-level exports
  owner?: string;
  // every declaring owner: a property of a union type (UseQueryResult.data)
  // is declared once per variant
  owners: string[];
  // the package's named types the member was reached through
  // (UseQueryResult, ResponseCreateParamsNonStreaming); names the use when
  // it has several owners
  via: string[];
  member?: string;
  kinds: ApiUseKind[];
  // package that declares it; family packages (query-core) count
  declaredIn: string;
  sites: { file: string; line: number }[];
  typeOnly: boolean;
  // every site is in a test file
  testOnly: boolean;
};

export type ApiUsage = { package: string; files: string[]; uses: ApiUse[]; notes: string[] };

const KIND_ORDER: ApiUseKind[] = ["new", "call", "jsx", "property", "option", "import", "type"];
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)__tests__\/)/;
const MAX_PRINTED_SITES = 3;

// ---- which declarations belong to the package ----

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

// the package and its dependencies in the same scope or named after it
// (query-core for react-query, @tamagui/* for tamagui); not every
// dependency, or @types/node would make `fs.readFileSync` "openai" API
const packageFamily = (projectRoot: string, pkg: string) => {
  const dir = findPackageDir(projectRoot, pkg);
  const deps = Object.keys((dir && readPackageJson(dir)?.dependencies) ?? {});
  const scope = pkg.startsWith("@") ? pkg.split("/")[0] : undefined;
  const related = (dep: string) =>
    scope ? dep.startsWith(`${scope}/`) : dep.startsWith(`${pkg}-`) || dep.startsWith(`@${pkg}/`);
  return new Set([pkg, ...deps.filter(related)]);
};

const resolveAlias = (checker: ts.TypeChecker, s: ts.Symbol) =>
  s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;

const nameText = (n: ts.Node | undefined) =>
  n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isPrivateIdentifier(n))
    ? n.text
    : undefined;

// the nearest named container of a member declaration; undefined when it
// sits at a module's top level (a top-level export)
const ownerOf = (decl: ts.Node): string | undefined => {
  for (let n = decl.parent; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isModuleDeclaration(n)) return ts.isStringLiteral(n.name) ? undefined : n.name.text;
    if (
      ts.isInterfaceDeclaration(n) ||
      ts.isClassLike(n) ||
      ts.isTypeAliasDeclaration(n) ||
      ts.isEnumDeclaration(n) ||
      ts.isFunctionDeclaration(n) ||
      ts.isVariableDeclaration(n)
    ) {
      const name = nameText(n.name);
      if (name) return name;
    }
  }
  return undefined;
};

// ---- collecting ----

type Draft = {
  api: string;
  owner?: string;
  owners: string[];
  via: Set<string>;
  member?: string;
  kinds: Set<ApiUseKind>;
  declaredIn: string;
  sites: Map<string, { file: string; line: number }>;
};

type Ctx = {
  checker: ts.TypeChecker;
  family: Set<string>;
  // every name the package's declarations declare
  names: Set<string>;
  // and the TypeScript lib's (push, set, from: containers options pass through)
  libNames: Set<string>;
  program: ts.Program;
  uses: Map<string, Draft>;
};

// A syntactic prefilter: a member the package declares has its name declared
// in one of its files, so other names never reach the checker. Resolving a
// member means typing its receiver, and some receivers are very expensive to
// type (a tRPC router took 100 s on its first touch).
const declaredNames = (files: readonly ts.SourceFile[]) => {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    const name = nameText((n as ts.NamedDeclaration).name);
    if (name !== undefined) names.add(name);
    ts.forEachChild(n, visit);
  };
  files.forEach(visit);
  return names;
};

const isFamilyFile = (family: Set<string>, file: string) => {
  const p = packageFromPath(file);
  return !!p && family.has(p);
};

const record = (
  ctx: Ctx,
  base: Omit<Draft, "kinds" | "sites" | "via"> & { via?: string },
  kind: ApiUseKind,
  site: { file: string; line: number },
) => {
  const { via, ...rest } = base;
  let d = ctx.uses.get(base.api);
  if (!d) {
    d = { ...rest, via: new Set(), kinds: new Set(), sites: new Map() };
    ctx.uses.set(base.api, d);
  }
  if (via) d.via.add(via);
  d.kinds.add(kind);
  d.sites.set(`${site.file}:${site.line}`, site);
};

const declsOf = (ctx: Ctx, s: ts.Symbol | undefined) =>
  s ? resolveAlias(ctx.checker, s).getDeclarations() ?? [] : [];

const familyDecls = (ctx: Ctx, s: ts.Symbol | undefined) =>
  declsOf(ctx, s).filter((d) => isFamilyFile(ctx.family, d.getSourceFile().fileName));

// the package's own name for a type, ignoring anonymous types, modules and
// lib aliases like Omit<...>
const typeName = (ctx: Ctx, type: ts.Type | undefined) => {
  if (!type) return undefined;
  const t = ctx.checker.getNonNullableType(type);
  for (const s of [t.aliasSymbol, t.getSymbol()]) {
    if (!s || s.flags & ts.SymbolFlags.Module || s.name.startsWith("__")) continue;
    if (familyDecls(ctx, s).length > 0) return s.name;
  }
  return undefined;
};

// a member use: attributed by declaration and named after its declaring
// owner, so one option set through two option types is one use; a union's
// member (declared once per variant) is named after the type it was reached
// through instead
const recordMember = (
  ctx: Ctx,
  symbols: (ts.Symbol | undefined)[],
  // lazily: only needed once the member turns out to be the package's
  receiver: () => ts.Type | undefined,
  kind: ApiUseKind,
  site: { file: string; line: number },
) => {
  const decls = symbols.flatMap((s) => familyDecls(ctx, s));
  if (decls.length === 0) return false;
  const member = resolveAlias(ctx.checker, symbols.find(Boolean)!).name;
  const declaredIn = packageFromPath(decls[0]!.getSourceFile().fileName)!;
  const owners = Array.from(new Set(decls.map(ownerOf).filter((o): o is string => !!o)));
  if (owners.length === 0) {
    record(ctx, { api: member, owners, declaredIn }, kind, site);
    return true;
  }
  const via = typeName(ctx, receiver());
  const owner = via && owners.includes(via) ? via : owners[0]!;
  const name = owners.length === 1 ? owner : via ?? owner;
  record(ctx, { api: `${name}.${member}`, owner, owners, via, member, declaredIn }, kind, site);
  return true;
};

// options are usually optional parameters (`Options | undefined`), and
// unions only expose properties every member shares
const propertiesOf = (ctx: Ctx, type: ts.Type | undefined, name: string) => {
  if (!type) return [];
  const t = ctx.checker.getNonNullableType(type);
  const direct = t.getProperty(name);
  if (direct || !t.isUnion()) return [direct];
  return t.types.map((m) => ctx.checker.getNonNullableType(m).getProperty(name));
};

// ---- which object literals can be the package's options ----

// Typing an object literal's context means resolving the call it's passed
// to, which can cost seconds on heavy types, so only literals that can reach
// the package are typed: arguments of its functions (or of lib containers
// like push, or of project functions whose parameter is annotated with its
// types), values annotated with its types, and props of its components.
// Options passed through unannotated project helpers are missed.

const referencesFamily = (ctx: Ctx, type: ts.TypeNode | undefined): boolean => {
  if (!type) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    const name = ts.isTypeReferenceNode(n) ? n.typeName : ts.isExpressionWithTypeArguments(n) ? n.expression : undefined;
    if (name) {
      const last = ts.isQualifiedName(name) ? name.right : ts.isPropertyAccessExpression(name) ? name.name : name;
      if (familyDecls(ctx, ctx.checker.getSymbolAtLocation(last)).length > 0) found = true;
    }
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      const p = packageOf(n.argument.literal.text);
      if (ctx.family.has(p)) found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(type);
  return found;
};

const calleeName = (e: ts.Expression) =>
  ts.isIdentifier(e) ? e : ts.isPropertyAccessExpression(e) ? e.name : undefined;

const acceptsFamilyArgument = (ctx: Ctx, call: ts.CallExpression | ts.NewExpression, index: number) => {
  const name = calleeName(call.expression);
  if (!name) return false;
  // a property callee is resolved by typing its receiver: only names that
  // can be the package's or the lib's are worth it
  if (ts.isPropertyAccessExpression(call.expression) && !ctx.names.has(name.text) && !ctx.libNames.has(name.text)) {
    return false;
  }
  return declsOf(ctx, ctx.checker.getSymbolAtLocation(name)).some((d) => {
    const file = d.getSourceFile();
    if (isFamilyFile(ctx.family, file.fileName) || ctx.program.isSourceFileDefaultLibrary(file)) return true;
    if (file.fileName.includes("/node_modules/")) return false;
    const fn = ts.isVariableDeclaration(d) && d.initializer ? d.initializer : d;
    if (!ts.isFunctionLike(fn)) return false;
    const param = fn.parameters[Math.min(index, fn.parameters.length - 1)];
    return !!param && referencesFamily(ctx, param.type);
  });
};

const isFamilyComponent = (ctx: Ctx, tag: ts.JsxTagNameExpression) => {
  const name = ts.isIdentifier(tag) ? tag : ts.isPropertyAccessExpression(tag) ? tag.name : undefined;
  if (!name || (ts.isPropertyAccessExpression(tag) && !ctx.names.has(name.text))) return false;
  return familyDecls(ctx, ctx.checker.getSymbolAtLocation(name)).length > 0;
};

const functionReturns = (ctx: Ctx, fn: ts.SignatureDeclaration): boolean | ts.Node =>
  fn.type ? referencesFamily(ctx, fn.type) : ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) ? fn : false;

// climbs from a literal through enclosing literals, spreads, conditionals
// and callbacks to whatever gives it its type
const isAnchored = (ctx: Ctx, literal: ts.Node): boolean => {
  let n = literal;
  for (;;) {
    const p = n.parent;
    if (
      ts.isPropertyAssignment(p) || ts.isSpreadAssignment(p) || ts.isSpreadElement(p) ||
      ts.isObjectLiteralExpression(p) || ts.isArrayLiteralExpression(p) || ts.isParenthesizedExpression(p) ||
      ts.isNonNullExpression(p) || ts.isConditionalExpression(p) ||
      (ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
    ) {
      n = p;
      continue;
    }
    if (ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) return referencesFamily(ctx, p.type);
    if (ts.isJsxExpression(p)) {
      const attr = p.parent;
      return ts.isJsxAttribute(attr) && isFamilyComponent(ctx, attr.parent.parent.tagName);
    }
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== n) {
      return acceptsFamilyArgument(ctx, p, p.arguments?.indexOf(n as ts.Expression) ?? 0);
    }
    if ((ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isParameter(p)) && p.initializer === n) {
      return referencesFamily(ctx, p.type);
    }
    const fn = ts.isReturnStatement(p)
      ? (ts.findAncestor(p, ts.isFunctionLike) as ts.SignatureDeclaration | undefined)
      : ts.isArrowFunction(p) && p.body === n ? p : undefined;
    if (!fn) return false;
    const r = functionReturns(ctx, fn);
    if (typeof r === "boolean") return r;
    n = r;
  }
};

// how an expression in callee/tag position is used
const valueKind = (e: ts.Node, fallback: ApiUseKind): ApiUseKind => {
  const p = e.parent;
  if ((ts.isCallExpression(p) || ts.isDecorator(p)) && p.expression === e) return "call";
  if (ts.isTaggedTemplateExpression(p) && p.tag === e) return "call";
  if (ts.isNewExpression(p) && p.expression === e) return "new";
  if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) && p.tagName === e) return "jsx";
  return fallback;
};

// a type reference (`Foo`, `ns.Foo`, `typeof Foo`, `implements Foo`)
const isTypePosition = (id: ts.Node) => {
  let n = id;
  while (ts.isQualifiedName(n.parent) || ts.isPropertyAccessExpression(n.parent)) n = n.parent;
  const p = n.parent;
  if (ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p) || ts.isImportTypeNode(p)) return true;
  if (ts.isExpressionWithTypeArguments(p)) {
    const clause = p.parent;
    return ts.isHeritageClause(clause) &&
      (clause.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(clause.parent));
  }
  return false;
};

// identifiers that name something rather than refer to the import
const isNameSlot = (id: ts.Identifier) => {
  const p = id.parent as ts.Node & { name?: ts.Node; propertyName?: ts.Node };
  if (ts.isShorthandPropertyAssignment(p)) return false;
  if (p.name === id || p.propertyName === id) return true;
  if (ts.isQualifiedName(p) && p.right === id) return true;
  if (ts.isJsxClosingElement(p)) return true;
  return ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p);
};

type Imported = { api: string; declaredIn: string; line: number; used: boolean; ns: boolean };

// local name -> what it imports, for imports of pkg and its subpaths
const importsOf = (ctx: Ctx, sf: ts.SourceFile, pkg: string, lineOf: (n: ts.Node) => number) => {
  const locals = new Map<string, Imported>();
  const resolved = (local: ts.Identifier, fallback: string) => {
    const s = ctx.checker.getSymbolAtLocation(local);
    const target = s && resolveAlias(ctx.checker, s);
    const decl = target?.getDeclarations()?.[0];
    let api = fallback;
    if (fallback === "default" && target) {
      api = target.name !== "default" && target.name !== "export="
        ? target.name
        : nameText((decl as ts.NamedDeclaration | undefined)?.name) ?? local.text;
    }
    const declaredIn = (decl && packageFromPath(decl.getSourceFile().fileName)) ?? pkg;
    return { api, declaredIn: ctx.family.has(declaredIn) ? declaredIn : pkg };
  };
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!isFromPackage(st.moduleSpecifier.text, pkg) || !st.importClause) continue;
    const line = lineOf(st);
    const clause = st.importClause;
    if (clause.name) locals.set(clause.name.text, { ...resolved(clause.name, "default"), line, used: false, ns: false });
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      locals.set(bindings.name.text, { api: `* as ${bindings.name.text}`, declaredIn: pkg, line, used: false, ns: true });
    } else if (bindings) {
      for (const el of bindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        locals.set(el.name.text, { ...resolved(el.name, imported), line, used: false, ns: false });
      }
    }
  }
  return locals;
};

// ---- which receivers can hold the package's objects ----

// Resolving `x.data` types `x`, which is where the cost is, so members are
// only resolved on expressions that mention a name that can carry the
// package's values: its imports, imports from project files that use it
// (useUser wrapping useQuery), and, to a fixpoint, variables, parameters
// and functions whose type or initializer mentions one of those, and
// callback parameters of calls that do. Purely syntactic and generous;
// values reaching the file any other way are missed.

const IDENT = /[A-Za-z_$][\w$]*/g;
const tokens = (text: string) => new Set(text.match(IDENT) ?? []);

const boundNames = (name: ts.BindingName, out: string[] = []) => {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) boundNames(el.name, out);
  return out;
};

const carriers = (sf: ts.SourceFile, seeds: Set<string>) => {
  const decls: { names: string[]; mentions: Set<string> }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isPropertyDeclaration(n)) {
      const parts: ts.Node[] = [];
      if (n.type) parts.push(n.type);
      if (n.initializer) parts.push(n.initializer);
      // for (const item of response.output)
      const loop = n.parent.parent;
      if (ts.isVariableDeclaration(n) && (ts.isForOfStatement(loop) || ts.isForInStatement(loop))) parts.push(loop.expression);
      const fn = n.parent;
      // (r) => r.output_text, as an argument of a call that mentions one
      if (ts.isParameter(n) && !n.type && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isCallExpression(fn.parent)) {
        parts.push(fn.parent.expression);
      }
      const names = ts.isPropertyDeclaration(n) ? [nameText(n.name) ?? ""] : boundNames(n.name);
      decls.push({ names, mentions: tokens(parts.map((x) => x.getText(sf)).join(" ")) });
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && ts.isIdentifier(n.left)) {
      // narrowed: error instanceof APIError
      decls.push({ names: [n.left.text], mentions: tokens(n.right.getText(sf)) });
    } else if (ts.isFunctionDeclaration(n) && n.name) {
      decls.push({ names: [n.name.text], mentions: tokens(n.getText(sf)) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const tainted = new Set(seeds);
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of decls) {
      if (d.names.every((x) => tainted.has(x))) continue;
      if ([...d.mentions].some((m) => tainted.has(m))) {
        d.names.forEach((x) => tainted.add(x));
        changed = true;
      }
    }
  }
  return tainted;
};

// local names bound by imports of pkg, syntactically
const packageLocals = (sf: ts.SourceFile, pkg: string) => {
  const names: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!isFromPackage(st.moduleSpecifier.text, pkg) || !st.importClause) continue;
    const { name, namedBindings: b } = st.importClause;
    if (name) names.push(name.text);
    if (b) names.push(...(ts.isNamespaceImport(b) ? [b.name.text] : b.elements.map((e) => e.name.text)));
  }
  return names;
};

// project files importing the package -> their names that carry its values
// (useUser wrapping useQuery); not every export, or one routing helper in a
// shared module would make all of its exports suspect
type Importing = Map<string, { sf: ts.SourceFile; carriers?: Set<string> }>;

// locals imported from such project files, under their local names
const projectSeeds = (sourceFile: SourceFile, importing: Importing, pkg: string) => {
  const seeds: string[] = [];
  for (const imp of sourceFile.getImportDeclarations()) {
    const entry = importing.get(imp.getModuleSpecifierSourceFile()?.getFilePath() ?? "");
    if (!entry) continue;
    entry.carriers ??= carriers(entry.sf, new Set(packageLocals(entry.sf, pkg)));
    const clause = imp.getImportClause()?.compilerNode;
    // the default export's name isn't known here; keep it
    if (clause?.name) seeds.push(clause.name.text);
    const b = clause?.namedBindings;
    if (b && ts.isNamespaceImport(b)) seeds.push(b.name.text);
    else if (b) {
      for (const e of b.elements) if (entry.carriers.has((e.propertyName ?? e.name).text)) seeds.push(e.name.text);
    }
  }
  return seeds;
};

const scanFile = (ctx: Ctx, sourceFile: SourceFile, file: string, pkg: string, importing: Importing) => {
  const sf = sourceFile.compilerNode;
  const { checker } = ctx;
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const site = (n: ts.Node) => ({ file, line: lineOf(n) });
  const locals = importsOf(ctx, sf, pkg, lineOf);
  const tainted = carriers(sf, new Set([...locals.keys(), ...projectSeeds(sourceFile, importing, pkg)]));
  // the receiver chain's root (client in client.responses.create(...).x),
  // not names in its arguments
  const carries = (n: ts.Node): boolean => {
    if (ts.isIdentifier(n)) return tainted.has(n.text);
    if (n.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (
      ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n) ||
      ts.isNewExpression(n) || ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) ||
      ts.isAwaitExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)
    ) {
      return carries(n.expression);
    }
    if (ts.isYieldExpression(n)) return !!n.expression && carries(n.expression);
    if (ts.isTaggedTemplateExpression(n)) return carries(n.tag);
    // destructuring: const { data } = <initializer>, ({ data }: Props)
    if (ts.isBindingElement(n)) return carries(n.parent.parent);
    if (ts.isVariableDeclaration(n) || ts.isParameter(n)) {
      return [...tokens([n.type, n.initializer].map((x) => x?.getText(sf) ?? "").join(" "))].some((t) => tainted.has(t));
    }
    return false;
  };
  // receivers already accounted for by the member use on them
  const skip = new Set<ts.Node>();
  // one lookup per object literal / JSX element / pattern, not per key
  const contextual = new Map<ts.Node, ts.Type | undefined>();
  const contextualOf = (n: ts.ObjectLiteralExpression | ts.JsxAttributes) => {
    if (!contextual.has(n)) {
      const anchored = ts.isJsxAttributes(n) ? isFamilyComponent(ctx, n.parent.tagName) : isAnchored(ctx, n);
      contextual.set(n, anchored ? checker.getContextualType(n) : undefined);
    }
    return contextual.get(n);
  };
  const typeOf = (n: ts.ObjectBindingPattern) => {
    if (!contextual.has(n)) contextual.set(n, checker.getTypeAtLocation(n));
    return contextual.get(n);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;

    if (ts.isExportDeclaration(node)) {
      // `export { x } from "pkg"`: passed through to other files
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec) && isFromPackage(spec.text, pkg)) {
        const names = node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map((e) => (e.propertyName ?? e.name).text)
          : ["*"];
        for (const api of names) record(ctx, { api, owners: [], declaredIn: pkg }, "import", site(node));
        return;
      }
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(key) ? key.text : undefined;
      if (name !== undefined && ctx.names.has(name) && carries(node.expression)) {
        const receiver = node.expression;
        const local = ts.isIdentifier(receiver) ? locals.get(receiver.text) : undefined;
        // namespace imports' type is the module, no name to take
        const receiverType = () => (local?.ns ? undefined : checker.getTypeAtLocation(receiver));
        const kind = isTypePosition(node) ? "type" : valueKind(node, "property");
        if (recordMember(ctx, [checker.getSymbolAtLocation(key)], receiverType, kind, site(key)) && local) {
          local.used = true;
          skip.add(receiver);
        }
      }
    } else if (ts.isQualifiedName(node) && !skip.has(node) && ctx.names.has(node.right.text)) {
      // types: only the full name (OpenAI.Responses.Response) is interesting
      if (recordMember(ctx, [checker.getSymbolAtLocation(node.right)], () => undefined, "type", site(node.right))) {
        for (let n: ts.EntityName = node.left; ; n = n.left) {
          skip.add(n);
          if (ts.isIdentifier(n)) {
            const local = locals.get(n.text);
            if (local) local.used = true;
            break;
          }
        }
      }
    } else if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node)) &&
      ts.isObjectLiteralExpression(node.parent)
    ) {
      const name = nameText(node.name);
      if (name !== undefined && ctx.names.has(name)) {
        const contextual = contextualOf(node.parent);
        recordMember(ctx, propertiesOf(ctx, contextual, name), () => contextual, "option", site(node.name));
      }
    } else if (ts.isJsxAttribute(node)) {
      const name = nameText(node.name);
      if (name !== undefined && ctx.names.has(name)) {
        const props = contextualOf(node.parent);
        recordMember(ctx, propertiesOf(ctx, props, name), () => props, "jsx", site(node.name));
      }
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && !node.dotDotDotToken) {
      // const { data, isLoading } = useQuery(...)
      const name = nameText(node.propertyName ?? node.name);
      if (name !== undefined && ctx.names.has(name) && carries(node.parent.parent)) {
        const type = typeOf(node.parent);
        recordMember(ctx, propertiesOf(ctx, type, name), () => type, "property", site(node));
      }
    } else if (ts.isIdentifier(node) && !skip.has(node)) {
      const local = locals.get(node.text);
      if (local && !isNameSlot(node)) {
        local.used = true;
        const kind = isTypePosition(node) ? "type" : valueKind(node, "import");
        record(ctx, { api: local.api, owners: [], declaredIn: local.declaredIn }, kind, site(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // imported but never referenced (or only for side effects of the import)
  for (const local of locals.values()) {
    if (!local.used) record(ctx, { api: local.api, owners: [], declaredIn: local.declaredIn }, "import", { file, line: local.line });
  }
};

const importsPkg = (sf: SourceFile, pkg: string) =>
  [...sf.getImportDeclarations(), ...sf.getExportDeclarations()].some((d) => {
    const spec = d.getModuleSpecifierValue();
    return !!spec && isFromPackage(spec, pkg);
  });

const finish = (d: Draft): ApiUse => {
  const sites = Array.from(d.sites.values()).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const kinds = KIND_ORDER.filter((k) => d.kinds.has(k));
  return {
    api: d.api,
    owner: d.owner,
    owners: d.owners,
    via: Array.from(d.via),
    member: d.member,
    kinds,
    declaredIn: d.declaredIn,
    sites,
    typeOnly: kinds.every((k) => k === "type"),
    testOnly: sites.every((s) => TEST_FILE.test(s.file)),
  };
};

// runtime production uses first, then test-only, then type-only
const rank = (u: ApiUse) => (u.typeOnly ? 2 : u.testOnly ? 1 : 0);
const groupOf = (u: ApiUse) => (u.member === undefined ? "" : u.api.slice(0, u.api.length - u.member.length - 1));

export const findApiUsage = (projectRoot: string, pkg: string): ApiUsage => {
  const root = path.resolve(projectRoot);
  const project = initializeAst(root);
  const program = project.getProgram().compilerObject;
  const checker = program.getTypeChecker();
  const family = packageFamily(root, pkg);
  const programFiles = program.getSourceFiles();
  const ctx: Ctx = {
    checker,
    family,
    names: declaredNames(programFiles.filter((f) => isFamilyFile(family, f.fileName))),
    libNames: declaredNames(programFiles.filter((f) => program.isSourceFileDefaultLibrary(f))),
    program,
    uses: new Map(),
  };
  const notes: string[] = [];
  if (!findPackageDir(root, pkg)) notes.push(`${pkg} isn't installed: members can't be resolved, only imported names.`);
  if (family.size > 1) notes.push(`Also attributed to ${pkg}: ${[...family].slice(1).join(", ")}.`);

  const importers = project.getSourceFiles().filter((sf) => !sf.isInNodeModules() && importsPkg(sf, pkg));
  const importing: Importing = new Map(importers.map((sf) => [sf.getFilePath() as string, { sf: sf.compilerNode }]));
  const files: string[] = [];
  for (const sf of importers) {
    const file = sf.getFilePath();
    // other workspaces reached through references or `paths` get their own run
    if (sf.isDeclarationFile() || !file.startsWith(root + path.sep)) continue;
    const rel = path.relative(root, file);
    files.push(rel);
    scanFile(ctx, sf, rel, pkg, importing);
  }
  if (files.length === 0) notes.push(`No project file imports ${pkg}.`);

  const uses = Array.from(ctx.uses.values(), finish).sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(a.member !== undefined) - Number(b.member !== undefined) ||
      groupOf(a).localeCompare(groupOf(b)) ||
      b.sites.length - a.sites.length ||
      a.api.localeCompare(b.api),
  );
  return { package: pkg, files: files.sort(), uses, notes };
};

// whether an api-diff member change concerns this use: same member, on the
// type it was reached through or one that declares it
export const matchesMemberChange = (
  use: ApiUse,
  change: { type: string; owner?: string; member: string },
) => {
  if (use.member === undefined || use.member !== change.member) return false;
  const names = new Set([...use.owners, ...use.via]);
  return names.has(change.type) || (!!change.owner && names.has(change.owner));
};

// ---- printing ----

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const printUse = (u: ApiUse) => {
  const shown = u.sites.slice(0, MAX_PRINTED_SITES).map((s) => `${s.file}:${s.line}`);
  const more = u.sites.length > MAX_PRINTED_SITES ? ` +${u.sites.length - MAX_PRINTED_SITES}` : "";
  const tags = [
    u.declaredIn !== "" ? `from ${u.declaredIn}` : "",
    u.owner && !u.api.startsWith(`${u.owner}.`) ? `declared in ${u.owners.join(" | ")}` : "",
    u.testOnly && !u.typeOnly ? "tests only" : "",
  ].filter(Boolean);
  console.log(
    `- ${u.api} (${u.kinds.join(", ")}; ${plural(u.sites.length, "site")}) ${shown.join(", ")}${more}` +
      (tags.length > 0 ? `  [${tags.join("; ")}]` : ""),
  );
};

export const printApiUsage = (u: ApiUsage) => {
  const runtime = u.uses.filter((x) => !x.typeOnly);
  console.log(`# API usage: ${u.package}`);
  console.log(
    `${plural(u.files.length, "file")} ${u.files.length === 1 ? "imports" : "import"} it; ${plural(u.uses.length, "API")} used (${runtime.length} at runtime, ${u.uses.length - runtime.length} type-only).`,
  );
  for (const n of u.notes) console.log(`note: ${n}`);
  if (u.uses.length === 0) return;

  const groups = new Map<string, ApiUse[]>();
  for (const use of runtime) {
    const g = groupOf(use);
    groups.set(g, [...(groups.get(g) ?? []), use]);
  }
  const top = groups.get("") ?? [];
  if (top.length > 0) {
    console.log(`\n## Top-level exports (${top.length})`);
    top.forEach(printUse);
  }
  const owned = [...groups].filter(([g]) => g !== "");
  for (const [g, list] of owned) {
    const sites = list.reduce((n, x) => n + x.sites.length, 0);
    console.log(`\n## ${g} (${plural(list.length, "member")}, ${plural(sites, "site")})`);
    list.forEach(printUse);
  }
  const types = u.uses.filter((x) => x.typeOnly);
  if (types.length > 0) {
    console.log(`\n## Type-only (${types.length})`);
    types.forEach(printUse);
  }
};
