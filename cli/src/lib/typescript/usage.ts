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
  // and the TypeScript lib's (push, set: containers options pass through)
  libNames: Set<string>;
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
  s ? (resolveAlias(ctx.checker, s).getDeclarations() ?? []) : [];

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
  const name = owners.length === 1 ? owner : (via ?? owner);
  record(ctx, { api: `${name}.${member}`, owner, owners, via, member, declaredIn }, kind, site);
  return true;
};

// options are usually optional parameters (`Options | undefined`), and
// unions only expose properties every member shares
const propertiesOf = (ctx: Ctx, type: ts.Type | undefined, name: string) => {
  if (!type) return [];
  let t = ctx.checker.getNonNullableType(type);
  // generic options (`options: TOptions`) are read through their constraint
  if (t.flags & ts.TypeFlags.TypeParameter) t = ctx.checker.getBaseConstraintOfType(t) ?? t;
  const direct = t.getProperty(name);
  if (direct || !t.isUnion()) return [direct];
  return t.types.map((m) => ctx.checker.getNonNullableType(m).getProperty(name));
};

// ---- the types option objects are written against ----

// What an object literal or JSX element is checked against, from declared
// types only: the callee's parameter, the component's props, an annotation,
// walked down through nested keys and array elements. Not the checker's
// contextual type: that resolves the whole call or element, typing every
// argument, which costs minutes on heavy types (tRPC, tamagui). Literals
// passed to unannotated project helpers have no declared target and are
// missed; generic parameters are read through their constraint.

// whether a type annotation names one of the package's types (by symbol,
// which is cheap; typing the annotation may not be)
const mentionsFamily = (ctx: Ctx, type: ts.TypeNode) => {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && ctx.names.has(n.text)) {
      found = familyDecls(ctx, ctx.checker.getSymbolAtLocation(n)).length > 0;
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      found = ctx.family.has(packageOf(n.argument.literal.text));
    }
    ts.forEachChild(n, visit);
  };
  visit(type);
  return found;
};

type Carries = (receiver: ts.Node) => boolean;

const makeExpected = (ctx: Ctx, carries: Carries) => {
  const { checker } = ctx;
  const memo = new Map<ts.Node, ts.Type[]>();
  const constraint = (t: ts.Type) =>
    t.flags & ts.TypeFlags.TypeParameter ? (checker.getBaseConstraintOfType(t) ?? t) : t;
  const parts = (t: ts.Type) => {
    const n = constraint(checker.getNonNullableType(t));
    return n.isUnion() ? n.types : [n];
  };
  // annotations are only typed when they name something of the package:
  // `Record<RouterOutputs["x"]["status"], ColorTokens>` alone can take minutes
  const annotated = (type: ts.TypeNode | undefined) => {
    if (!type || !mentionsFamily(ctx, type)) return [];
    return [checker.getTypeFromTypeNode(type)];
  };
  const propType = (types: ts.Type[], name: string) =>
    types.flatMap(parts).flatMap((t) => {
      const p = t.getProperty(name);
      return p ? [checker.getTypeOfSymbol(p)] : [];
    });

  // a callee's type, when it's cheap: declared functions and classes, and
  // package and lib methods on receivers that can hold the package's values
  const calleeType = (callee: ts.Expression): ts.Type | undefined => {
    if (ts.isPropertyAccessExpression(callee)) {
      const name = callee.name.text;
      if ((!ctx.names.has(name) && !ctx.libNames.has(name)) || !carries(callee.expression)) return undefined;
      return checker.getTypeAtLocation(callee);
    }
    if (!ts.isIdentifier(callee)) return undefined;
    const s = checker.getSymbolAtLocation(callee);
    const target = s && resolveAlias(checker, s);
    const decl = target?.declarations?.[0];
    if (!target || !decl) return undefined;
    if (decl.getSourceFile().isDeclarationFile) return checker.getTypeOfSymbol(target);
    // project functions: only when a parameter is annotated with the
    // package's types, and never inferred locals (`const f = useCallback(...)`
    // types the whole callback)
    const fn = ts.isVariableDeclaration(decl) ? decl.initializer : decl;
    const params =
      fn &&
      (ts.isFunctionLike(fn)
        ? fn.parameters
        : ts.isClassDeclaration(fn)
          ? fn.members.find(ts.isConstructorDeclaration)?.parameters
          : undefined);
    return params?.some((p) => p.type && mentionsFamily(ctx, p.type)) ? checker.getTypeOfSymbol(target) : undefined;
  };

  const parameterTypes = (callee: ts.Expression, index: number, construct: boolean) => {
    const t = calleeType(callee);
    if (!t) return [];
    return parts(t)
      .flatMap((x) => (construct ? x.getConstructSignatures() : x.getCallSignatures()))
      .flatMap((sig) => {
        const params = sig.getParameters();
        const p = params[Math.min(index, params.length - 1)];
        if (!p) return [];
        const decl = p.valueDeclaration;
        if (decl && ts.isParameter(decl) && !decl.getSourceFile().isDeclarationFile && !annotated(decl.type).length)
          return [];
        const pt = checker.getTypeOfSymbol(p);
        const rest = !!decl && ts.isParameter(decl) && !!decl.dotDotDotToken;
        const el = rest ? checker.getIndexTypeOfType(pt, ts.IndexKind.Number) : pt;
        return el ? [el] : [];
      });
  };

  // function components' first parameter; class components' constructor's
  const propsOf = (tag: ts.JsxTagNameExpression) => {
    if (!ts.isIdentifier(tag) && !ts.isPropertyAccessExpression(tag)) return [];
    return [...parameterTypes(tag, 0, false), ...parameterTypes(tag, 0, true)];
  };

  const returnTypes = (fn: ts.SignatureDeclaration): ts.Type[] =>
    fn.type
      ? annotated(fn.type)
      : ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)
        ? expected(fn)
            .flatMap(parts)
            .flatMap((t) => t.getCallSignatures().map((sig) => sig.getReturnType()))
        : [];

  const compute = (n: ts.Node): ts.Type[] => {
    if (ts.isJsxAttributes(n)) return propsOf(n.parent.tagName);
    const p = n.parent;
    if (ts.isPropertyAssignment(p) && p.initializer === n) {
      const name = nameText(p.name);
      return name === undefined ? [] : propType(expected(p.parent), name);
    }
    if (ts.isJsxExpression(p)) {
      const attr = p.parent;
      const name = ts.isJsxAttribute(attr) ? nameText(attr.name) : undefined;
      return name === undefined ? [] : propType(expected(attr.parent), name);
    }
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isSpreadElement(p) ||
      (ts.isConditionalExpression(p) && p.condition !== n) ||
      (ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
    ) {
      return expected(p);
    }
    // { ...cond ? { a } : {} } is checked against the enclosing literal's type
    if (ts.isSpreadAssignment(p)) return expected(p.parent);
    if (ts.isArrayLiteralExpression(p)) {
      return expected(p)
        .flatMap(parts)
        .flatMap((t) => checker.getIndexTypeOfType(t, ts.IndexKind.Number) ?? []);
    }
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== n) {
      return parameterTypes(p.expression, p.arguments?.indexOf(n as ts.Expression) ?? 0, ts.isNewExpression(p));
    }
    if ((ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isParameter(p)) && p.initializer === n) {
      return annotated(p.type);
    }
    if (ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) {
      return ts.isConstTypeReference(p.type) ? expected(p) : annotated(p.type);
    }
    if (ts.isReturnStatement(p)) {
      const fn = ts.findAncestor(p, ts.isFunctionLike) as ts.SignatureDeclaration | undefined;
      return fn ? returnTypes(fn) : [];
    }
    if (ts.isArrowFunction(p) && p.body === n) return returnTypes(p);
    return [];
  };

  const expected = (n: ts.Node): ts.Type[] => {
    let types = memo.get(n);
    if (!types) {
      memo.set(n, []); // cycles
      types = compute(n);
      memo.set(n, types);
    }
    return types;
  };
  return expected;
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
    return (
      ts.isHeritageClause(clause) &&
      (clause.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(clause.parent))
    );
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
      api =
        target.name !== "default" && target.name !== "export="
          ? target.name
          : (nameText((decl as ts.NamedDeclaration | undefined)?.name) ?? local.text);
    }
    const declaredIn = (decl && packageFromPath(decl.getSourceFile().fileName)) ?? pkg;
    return { api, declaredIn: ctx.family.has(declaredIn) ? declaredIn : pkg };
  };
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!isFromPackage(st.moduleSpecifier.text, pkg) || !st.importClause) continue;
    const line = lineOf(st);
    const clause = st.importClause;
    if (clause.name)
      locals.set(clause.name.text, { ...resolved(clause.name, "default"), line, used: false, ns: false });
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      locals.set(bindings.name.text, {
        api: `* as ${bindings.name.text}`,
        declaredIn: pkg,
        line,
        used: false,
        ns: true,
      });
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

// Resolving `x.data` types `x`, which is where the cost is (a tRPC router
// took 100 s on its first touch), so members are only resolved on receivers
// rooted in a variable that can hold the package's values: its imports,
// imports of project functions that use it (useUser wrapping useQuery), and,
// to a fixpoint, variables, parameters and functions whose annotation or
// value flows from one of those, and callback parameters of calls on one.
// Tracked by symbol, so a callback's `r` isn't every `r` in the file.
// Values reaching the file any other way (untyped helpers in other files,
// globals) are missed.

// the identifiers a value can come from: `x.y`, `f(x)`, `c ? x : y`,
// `x ?? y`, what callbacks return; not what comparisons, arithmetic or
// templates produce (`mode === "PROFILE"` is a boolean, whatever mode is)
//
// A call's arguments only count when the callee is a library function or
// method (useMemo(() => x), Effect.tryPromise({ try: ... })): a project hook
// or a method on a local object (trpc.x.queryOptions(input)) returns
// something of its own, and typing it can be what's expensive.
const makeFlow = (checker: ts.TypeChecker) => {
  const passesArguments = (callee: ts.Expression) => {
    if (ts.isIdentifier(callee)) {
      // a library function or an adapter parameter (Effect.gen's `_`), not a
      // project hook, which returns its own thing
      const s = checker.getSymbolAtLocation(callee);
      const decl = (s && resolveAlias(checker, s))?.declarations?.[0];
      return !!decl && (decl.getSourceFile().isDeclarationFile || (ts.isParameter(decl) && !decl.type));
    }
    let root: ts.Expression = callee;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    if (!ts.isIdentifier(root)) return false;
    const decl = checker.getSymbolAtLocation(root)?.declarations?.[0];
    return (
      !!decl &&
      (decl.getSourceFile().isDeclarationFile ||
        ts.isImportSpecifier(decl) ||
        ts.isNamespaceImport(decl) ||
        ts.isImportClause(decl))
    );
  };

  const flowIds = (e: ts.Node | undefined, out: ts.Identifier[] = []): ts.Identifier[] => {
    if (!e) return out;
    if (ts.isIdentifier(e)) out.push(e);
    else if (
      ts.isPropertyAccessExpression(e) ||
      ts.isElementAccessExpression(e) ||
      ts.isParenthesizedExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isAwaitExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isTypeAssertionExpression(e) ||
      ts.isSpreadElement(e) ||
      ts.isSpreadAssignment(e) ||
      ts.isYieldExpression(e)
    ) {
      flowIds(e.expression, out);
    } else if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
      flowIds(e.expression, out);
      if (passesArguments(e.expression)) e.arguments?.forEach((x) => flowIds(x, out));
    } else if (ts.isTaggedTemplateExpression(e)) flowIds(e.tag, out);
    else if (ts.isConditionalExpression(e)) {
      flowIds(e.whenTrue, out);
      flowIds(e.whenFalse, out);
    } else if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        flowIds(e.left, out);
        flowIds(e.right, out);
      } else if (op === ts.SyntaxKind.CommaToken || op === ts.SyntaxKind.EqualsToken) flowIds(e.right, out);
    } else if (ts.isObjectLiteralExpression(e)) {
      for (const prop of e.properties) {
        if (ts.isPropertyAssignment(prop)) flowIds(prop.initializer, out);
        else if (ts.isShorthandPropertyAssignment(prop)) out.push(prop.name);
        else if (ts.isSpreadAssignment(prop)) flowIds(prop.expression, out);
        else if (ts.isMethodDeclaration(prop)) returnIds(prop, out);
      }
    } else if (ts.isArrayLiteralExpression(e)) e.elements.forEach((x) => flowIds(x, out));
    else if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) returnIds(e, out);
    return out;
  };

  // what a function returns: its expression body or its own return statements
  const returnIds = (fn: ts.FunctionLikeDeclaration, out: ts.Identifier[]) => {
    if (!fn.body) return out;
    if (!ts.isBlock(fn.body)) return flowIds(fn.body, out);
    const visit = (n: ts.Node): void => {
      if (ts.isReturnStatement(n)) flowIds(n.expression, out);
      else if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit);
    };
    ts.forEachChild(fn.body, visit);
    return out;
  };

  return { flowIds, returnIds };
};

const typeIds = (type: ts.TypeNode | undefined, out: ts.Identifier[] = []) => {
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  if (type) visit(type);
  return out;
};

const boundIds = (name: ts.BindingName, out: ts.Identifier[] = []) => {
  if (ts.isIdentifier(name)) out.push(name);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) boundIds(el.name, out);
  return out;
};

const symbolOf = (checker: ts.TypeChecker, id: ts.Identifier) => {
  const s =
    ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
      ? checker.getShorthandAssignmentValueSymbol(id.parent)
      : checker.getSymbolAtLocation(id);
  return s && checker.getExportSymbolOfSymbol(s);
};

const carriers = (checker: ts.TypeChecker, sf: ts.SourceFile, seeds: ts.Symbol[]) => {
  const { flowIds, returnIds } = makeFlow(checker);
  const decls: { names: ts.Identifier[]; from: ts.Identifier[] }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isPropertyDeclaration(n)) {
      const from = flowIds(n.initializer, typeIds(n.type));
      // for (const item of response.output)
      const loop = n.parent.parent;
      if (ts.isVariableDeclaration(n) && (ts.isForOfStatement(loop) || ts.isForInStatement(loop)))
        flowIds(loop.expression, from);
      const fn = n.parent;
      // (r) => r.output_text, as a callback of a call on one
      if (
        ts.isParameter(n) &&
        !n.type &&
        (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
        ts.isCallExpression(fn.parent)
      ) {
        flowIds(fn.parent.expression, from);
      }
      const names = ts.isPropertyDeclaration(n) ? (ts.isIdentifier(n.name) ? [n.name] : []) : boundIds(n.name);
      decls.push({ names, from });
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      ts.isIdentifier(n.left)
    ) {
      // narrowed: error instanceof APIError (the narrowed variable as a whole)
      decls.push({ names: [n.left], from: flowIds(n.right) });
    } else if (ts.isFunctionDeclaration(n) && n.name) {
      decls.push({ names: [n.name], from: returnIds(n, typeIds(n.type)) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const resolved = decls.map((d) => ({
    names: d.names.map((x) => symbolOf(checker, x)).filter((x): x is ts.Symbol => !!x),
    from: d.from.map((x) => symbolOf(checker, x)).filter((x): x is ts.Symbol => !!x),
  }));
  const tainted = new Set(seeds);
  for (let changed = true; changed;) {
    changed = false;
    for (const d of resolved) {
      if (d.names.every((x) => tainted.has(x)) || !d.from.some((x) => tainted.has(x))) continue;
      d.names.forEach((x) => tainted.add(x));
      changed = true;
    }
  }
  return tainted;
};

// the local symbols bound by imports of pkg, or of `accept`ed names from
// other modules
const importSymbols = (
  checker: ts.TypeChecker,
  sf: ts.SourceFile,
  match: (spec: string) => boolean,
  accept: (local: ts.Identifier) => boolean = () => true,
) => {
  const ids: ts.Identifier[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!match(st.moduleSpecifier.text) || !st.importClause) continue;
    const { name, namedBindings: b } = st.importClause;
    if (name) ids.push(name);
    if (b) ids.push(...(ts.isNamespaceImport(b) ? [b.name] : b.elements.map((e) => e.name)));
  }
  return ids
    .filter(accept)
    .map((id) => checker.getSymbolAtLocation(id))
    .filter((x): x is ts.Symbol => !!x);
};

// project files importing the package -> their symbols that carry its
// values; not every export, or one routing helper in a shared module would
// make all of its exports suspect
type Importing = Map<string, { sf: ts.SourceFile; carriers?: Set<ts.Symbol> }>;

const projectSeeds = (ctx: Ctx, sourceFile: SourceFile, importing: Importing, pkg: string) => {
  const { checker } = ctx;
  const targets = new Map<string, Importing extends Map<string, infer V> ? V : never>();
  for (const imp of sourceFile.getImportDeclarations()) {
    const entry = importing.get(imp.getModuleSpecifierSourceFile()?.getFilePath() ?? "");
    if (entry) targets.set(imp.getModuleSpecifierValue(), entry);
  }
  return importSymbols(
    checker,
    sourceFile.compilerNode,
    (spec) => targets.has(spec),
    (local) => {
      const decl = local.parent;
      const st = ts.findAncestor(decl, ts.isImportDeclaration)!;
      const entry = targets.get((st.moduleSpecifier as ts.StringLiteral).text)!;
      entry.carriers ??= carriers(
        checker,
        entry.sf,
        importSymbols(checker, entry.sf, (spec) => isFromPackage(spec, pkg)),
      );
      // namespace and default imports: kept whole
      if (!ts.isImportSpecifier(decl)) return true;
      const alias = checker.getSymbolAtLocation(local);
      const target = alias && checker.getExportSymbolOfSymbol(resolveAlias(checker, alias));
      return !!target && entry.carriers.has(target);
    },
  );
};

// whether calling an imported function can hand back the package's API:
// useRouter() returns a Router, useLocalSearchParams() just strings, and
// everything derived from those would otherwise count; from declared return
// types, which are cheap. Non-functions (classes, objects, types) always can.
const returnsApi = (ctx: Ctx, alias: ts.Symbol) => {
  const { checker } = ctx;
  const target = resolveAlias(checker, alias);
  if (!(target.flags & ts.SymbolFlags.Function)) return true;
  const sigs = checker.getTypeOfSymbol(target).getCallSignatures();
  const hasApi = (type: ts.Type, depth: number): boolean => {
    let t = checker.getNonNullableType(type);
    if (t.flags & ts.TypeFlags.TypeParameter) t = checker.getBaseConstraintOfType(t) ?? t;
    if (t.isUnion() || t.isIntersection()) return t.types.some((x) => hasApi(x, depth));
    if (t.getCallSignatures().some((sig) => depth > 0 && hasApi(sig.getReturnType(), depth - 1))) return true;
    return t.getProperties().some((p) => familyDecls(ctx, p).length > 0);
  };
  return sigs.length === 0 || sigs.some((sig) => hasApi(sig.getReturnType(), 1));
};

const scanFile = (ctx: Ctx, sourceFile: SourceFile, file: string, pkg: string, importing: Importing) => {
  const sf = sourceFile.compilerNode;
  const { checker } = ctx;
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const site = (n: ts.Node) => ({ file, line: lineOf(n) });
  const locals = importsOf(ctx, sf, pkg, lineOf);
  const tainted = carriers(checker, sf, [
    ...importSymbols(checker, sf, (spec) => isFromPackage(spec, pkg)).filter((s) => returnsApi(ctx, s)),
    ...projectSeeds(ctx, sourceFile, importing, pkg),
  ]);
  const { flowIds } = makeFlow(checker);
  const taints = (ids: ts.Identifier[]) =>
    ids.some((id) => {
      const s = symbolOf(checker, id);
      return !!s && tainted.has(s);
    });
  // the receiver chain's root (client in client.responses.create(...).x),
  // not names in its arguments
  const carries = (n: ts.Node): boolean => {
    if (ts.isIdentifier(n)) return taints([n]);
    if (n.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (
      ts.isPropertyAccessExpression(n) ||
      ts.isElementAccessExpression(n) ||
      ts.isCallExpression(n) ||
      ts.isNewExpression(n) ||
      ts.isParenthesizedExpression(n) ||
      ts.isNonNullExpression(n) ||
      ts.isAwaitExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isSatisfiesExpression(n)
    ) {
      return carries(n.expression);
    }
    if (ts.isYieldExpression(n)) return !!n.expression && carries(n.expression);
    if (ts.isTaggedTemplateExpression(n)) return carries(n.tag);
    // destructuring: const { data } = <initializer>, ({ data }: Props)
    if (ts.isBindingElement(n)) return carries(n.parent.parent);
    if (ts.isVariableDeclaration(n) || ts.isParameter(n)) return taints(flowIds(n.initializer, typeIds(n.type)));
    return false;
  };
  // receivers already accounted for by the member use on them
  const skip = new Set<ts.Node>();
  const expected = makeExpected(ctx, carries);
  const contextual = new Map<ts.Node, ts.Type | undefined>();
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
        const names =
          node.exportClause && ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements.map((e) => (e.propertyName ?? e.name).text)
            : ["*"];
        for (const api of names) record(ctx, { api, owners: [], declaredIn: pkg }, "import", site(node));
        return;
      }
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(key)
          ? key.text
          : undefined;
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
        const types = expected(node.parent);
        const props = types.flatMap((t) => propertiesOf(ctx, t, name));
        recordMember(ctx, props, () => types.find((t) => typeName(ctx, t)), "option", site(node.name));
      }
    } else if (ts.isJsxAttribute(node)) {
      const name = nameText(node.name);
      if (name !== undefined && ctx.names.has(name)) {
        const types = expected(node.parent);
        const props = types.flatMap((t) => propertiesOf(ctx, t, name));
        recordMember(ctx, props, () => types.find((t) => typeName(ctx, t)), "jsx", site(node.name));
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
    if (!local.used)
      record(ctx, { api: local.api, owners: [], declaredIn: local.declaredIn }, "import", { file, line: local.line });
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
export const matchesMemberChange = (use: ApiUse, change: { type: string; owner?: string; member: string }) => {
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
