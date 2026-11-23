import path from "path";
import semver from "semver";
import type { Symbol as MorphSymbol, Type } from "ts-morph";
import { Node, Project, SyntaxKind, ts } from "ts-morph";

import { fetchPackage, packageOf, shipsTypes, typesPackageName } from "../fetch-package";
import { installedVersion, readPackageJson } from "../packages";
import { getPackument, resolveVersion } from "../registry";
import { isFromPackage } from "./ast";
import { declarationText, findPackageDir } from "./analyze";
import { initializeAst } from "./index";

// Compares the declarations of the names a project imports from a package
// between two versions: removed names, changed signatures, and one level
// into the object types those signatures use (options, results), where
// renamed members, new defaults, deprecations and reworded docs show up.
// The last group compiles fine and is the easiest to miss.

export type ImportedSymbol = {
  // exported name; "default" for default imports
  name: string;
  module: string;
  importedAt: string[];
};

export type ProjectImports = {
  files: string[];
  sites: number;
  symbols: ImportedSymbol[];
  // identifiers in the importing files, to flag members the project mentions
  words: Set<string>;
};

export type MemberChangeKind =
  | "removed"
  | "added"
  | "type"
  | "optionality"
  | "default"
  | "deprecated"
  | "description";

export type MemberChange = {
  kind: MemberChangeKind;
  // the named type the member was reached through, e.g. UseQueryOptions
  type: string;
  // the interface/alias that declares the member, e.g. QueryObserverOptions
  owner?: string;
  member: string;
  from?: string;
  to?: string;
  // added members only
  required?: boolean;
  // the member's name appears in a file that imports the package
  mentioned: boolean;
};

export type SymbolStatus = "removed" | "added" | "changed" | "unchanged" | "unresolved";

export type SymbolDiff = ImportedSymbol & {
  status: SymbolStatus;
  signatureChanged: boolean;
  old?: string;
  new?: string;
  // the symbol itself became deprecated
  deprecated?: string;
  members: MemberChange[];
  // object types its signature references in only one of the versions
  typesOnlyOld: string[];
  typesOnlyNew: string[];
};

export type ApiDiff = {
  package: string;
  from: string;
  to: string;
  fromSource: "installed" | "registry";
  toSource: "installed" | "registry";
  importingFiles: string[];
  importSites: number;
  unresolvedModules: { module: string; in: "from" | "to" | "both" }[];
  symbols: SymbolDiff[];
  notes: string[];
};

export const BEHAVIOR_KINDS: MemberChangeKind[] = ["default", "deprecated", "description"];

// A behavior change worth checking: a documented default that changed
// (it bites exactly where the option is *not* set), or a deprecation or
// doc change on a member the project mentions. Newly documented defaults
// and docs on unused members are mostly noise.
export const isRelevantBehavior = (m: MemberChange) =>
  BEHAVIOR_KINDS.includes(m.kind) &&
  ((m.kind === "default" && m.from !== undefined) || m.mentioned);

const MAX_SIGNATURE = 1500;
const MAX_MEMBER_TYPE = 200;
const MAX_TYPES_PER_SYMBOL = 30;
const MAX_TYPE_DEPTH = 3;

const clipTo = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)} …[truncated]` : text;

// doc text without links and formatting, so moved docs sites and reflowed
// markdown don't read as behavior changes
export const normalizeDoc = (text: string) =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<?https?:\/\/[^\s)>]+>?/g, "")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// the part of the docs that actually changed, with a little context
export const docDelta = (from: string, to: string, context = 50) => {
  const a = normalizeDoc(from);
  const b = normalizeDoc(to);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end++;
  }
  const before = a.slice(Math.max(0, start - context), start);
  const after = a.slice(a.length - end, a.length - end + context);
  const removed = a.slice(start, a.length - end);
  const added = b.slice(start, b.length - end);
  return `${start > context ? "…" : ""}${before}${removed ? `[-${removed}-]` : ""}${added ? `{+${added}+}` : ""}${after}${end > context ? "…" : ""}`;
};

const normalize = (text: string) =>
  text
    .replace(/\b(export\s+)?(declare\s+)/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(){}<>,;:|&=?[\]])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();

// ---- the project's imports ----

export const collectImports = (projectRoot: string, pkgs: string[]) => {
  const project = initializeAst(projectRoot);
  const result = new Map<string, ProjectImports>(
    pkgs.map((p) => [p, { files: [], sites: 0, symbols: [], words: new Set() }]),
  );
  const symbols = new Map<string, Map<string, ImportedSymbol>>();

  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isInNodeModules()) continue;
    const rel = path.relative(projectRoot, sourceFile.getFilePath());
    const decls = [
      ...sourceFile.getImportDeclarations(),
      ...sourceFile.getExportDeclarations(),
    ];
    for (const pkg of pkgs) {
      const entry = result.get(pkg)!;
      const byKey = symbols.get(pkg) ?? new Map<string, ImportedSymbol>();
      symbols.set(pkg, byKey);
      let touched = false;

      for (const decl of decls) {
        const specifier = decl.getModuleSpecifierValue();
        if (!specifier || !isFromPackage(specifier, pkg)) continue;
        touched = true;
        entry.sites++;
        const site = `${rel}:${decl.getStartLineNumber()}`;
        const add = (name: string) => {
          const key = `${specifier}#${name}`;
          const existing = byKey.get(key);
          if (existing) {
            if (!existing.importedAt.includes(site)) existing.importedAt.push(site);
          } else byKey.set(key, { name, module: specifier, importedAt: [site] });
        };

        if (Node.isImportDeclaration(decl)) {
          decl.getNamedImports().forEach((n) => add(n.getName()));
          if (decl.getDefaultImport()) add("default");
          // import * as X: the names used as X.name
          const ns = decl.getNamespaceImport()?.getText();
          if (ns) {
            for (const access of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
              if (access.getExpression().getText() === ns) add(access.getName());
            }
          }
        } else {
          decl.getNamedExports().forEach((n) => add(n.getName()));
        }
      }

      if (touched) {
        entry.files.push(rel);
        for (const m of sourceFile.getFullText().matchAll(/[A-Za-z_$][\w$]*/g)) {
          entry.words.add(m[0]);
        }
      }
    }
  }

  for (const [pkg, entry] of result) {
    entry.symbols = Array.from(symbols.get(pkg)?.values() ?? []);
  }
  return result;
};

// ---- loading one version's types ----

type VersionTypes = {
  version: string;
  source: "installed" | "registry";
  // module names resolved from a file in here get this version
  root: string;
  hasTypes: boolean;
};

const locateVersion = async (
  projectRoot: string,
  pkg: string,
  version: string,
): Promise<VersionTypes> => {
  const installedDir = findPackageDir(projectRoot, pkg);
  if (installedDir && installedVersion(projectRoot, pkg) === version) {
    return {
      version,
      source: "installed",
      root: projectRoot,
      hasTypes: shipsTypes(installedDir) || !!findPackageDir(projectRoot, typesPackageName(pkg)),
    };
  }
  const fetched = await fetchPackage(projectRoot, pkg, version);
  return {
    version,
    source: "registry",
    root: fetched.root,
    hasTypes: shipsTypes(fetched.dir) || !!fetched.typesDir,
  };
};

const versionProject = (projectRoot: string, root: string, pkg: string) => {
  // packages the fetched version doesn't bring (react, @types/react) come
  // from the project; the diffed package itself never does, or a subpath
  // missing from the new version would silently resolve to the old one
  const fallback = path.join(projectRoot, "__safebump_resolve__.ts");
  return new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
      typeRoots: [path.join(projectRoot, "node_modules", "@types")],
    },
    resolutionHost: (host, getOptions) => ({
      resolveModuleNames: (names, containingFile) =>
        names.map((name) => {
          const options = getOptions();
          const resolved = ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
          if (resolved || name.startsWith(".") || packageOf(name) === pkg) return resolved;
          return ts.resolveModuleName(name, fallback, options, host).resolvedModule;
        }),
    }),
  });
};

type Lookup = (name: string) => MorphSymbol | undefined;

type Loaded = {
  project: Project;
  // per module specifier: exported symbol by name, undefined if unresolved
  modules: Map<string, Lookup | undefined>;
  owned: (file: string) => boolean;
};

const ownerOf = (file: string) => {
  const nm = /.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file)?.[1];
  if (nm) return nm;
  return /\/packages\/((?:@[^/]+\/)?[^/@]+)@[^/]+\/package\//.exec(file)?.[1];
};

const loadVersion = (
  projectRoot: string,
  pkg: string,
  v: VersionTypes,
  specifiers: string[],
): Loaded => {
  const project = versionProject(projectRoot, v.root, pkg);
  const probe = project.createSourceFile(
    path.join(v.root, "__safebump_probe__.ts"),
    specifiers.map((s, i) => `import * as m${i} from ${JSON.stringify(s)};`).join("\n"),
    { overwrite: true },
  );
  const checker = project.getTypeChecker();
  const modules = new Map<string, Lookup | undefined>();
  probe.getImportDeclarations().forEach((imp, i) => {
    const ns = imp.getNamespaceImport()?.getSymbol();
    const target = ns?.isAlias() ? ns.getAliasedSymbol() : undefined;
    if (!target || target.getDeclarations().length === 0) {
      modules.set(specifiers[i]!, undefined);
      return;
    }
    const exports = new Map<string, MorphSymbol>();
    for (const s of checker.getExportsOfModule(target)) exports.set(s.getName(), s);
    // `export = value` (CommonJS typings like @types/lodash): named imports
    // are properties of the value's type, and the default is the value
    const valueDecl = target.getValueDeclaration();
    const isValue = !!valueDecl && !Node.isSourceFile(valueDecl) && !Node.isModuleDeclaration(valueDecl);
    const valueType = isValue ? checker.getTypeOfSymbolAtLocation(target, probe) : undefined;
    modules.set(specifiers[i]!, (name) =>
      exports.get(name) ??
      valueType?.getProperty(name) ??
      (name === "default" && isValue ? target : undefined),
    );
  });

  // the package, its @types and its dependencies at this version; not react,
  // the TypeScript lib, or anything else it merely mentions
  const pkgJson = readPackageJson(
    v.source === "installed"
      ? findPackageDir(projectRoot, pkg) ?? projectRoot
      : path.join(v.root, "package"),
  );
  const ownedNames = new Set([
    pkg,
    typesPackageName(pkg),
    ...Object.keys(pkgJson?.dependencies ?? {}),
  ]);
  const owned = (file: string) => {
    const owner = ownerOf(file);
    return !!owner && ownedNames.has(owner);
  };
  return { project, modules, owned };
};

// ---- comparing ----

type MemberInfo = {
  name: string;
  owner: string;
  optional: boolean;
  type: string;
  description: string;
  default?: string;
  deprecated?: string;
};

const resolveAlias = (s: MorphSymbol) => (s.isAlias() ? s.getAliasedSymbol() ?? s : s);

const jsDocInfo = (decls: Node[]) => {
  let description = "";
  let dflt: string | undefined;
  let deprecated: string | undefined;
  for (const d of decls) {
    if (!Node.isJSDocable(d)) continue;
    for (const doc of d.getJsDocs()) {
      // union members (one per result variant) carry several docs; the
      // longest is usually the general one on the base interface
      const text = doc.getDescription().trim();
      if (text.length > description.length) description = text;
      for (const tag of doc.getTags()) {
        const name = tag.getTagName();
        const text = (tag.getCommentText() ?? "").trim();
        if ((name === "default" || name === "defaultValue") && dflt === undefined) dflt = text;
        if (name === "deprecated" && deprecated === undefined) deprecated = text || "deprecated";
      }
    }
  }
  return { description, default: dflt, deprecated };
};

export const ownerName = (decl: Node | undefined) => {
  const parent = decl?.getParent();
  if (parent && (Node.isInterfaceDeclaration(parent) || Node.isClassDeclaration(parent))) {
    return parent.getName() ?? "?";
  }
  return parent?.getFirstAncestorByKind(SyntaxKind.TypeAliasDeclaration)?.getName() ?? "?";
};

const isLib = (file: string) => /\/node_modules\/typescript\/lib\//.test(file);

// object-like, i.e. worth diffing member by member: not functions, arrays,
// primitives, or built-ins from the TypeScript lib
const isObjectish = (type: Type): boolean => {
  if (type.isUnion()) {
    const parts = type.getUnionTypes().filter((t) => !t.isNull() && !t.isUndefined());
    return parts.length > 0 && parts.every(isObjectish);
  }
  if (type.isIntersection()) return type.getIntersectionTypes().some(isObjectish);
  if (!type.isObject() || type.getCallSignatures().length > 0) return false;
  const decl = (type.getSymbol() ?? type.getAliasSymbol())?.getDeclarations()[0];
  return !decl || !isLib(decl.getSourceFile().getFilePath());
};

const isNonPublic = (decl: Node) =>
  Node.isModifierable(decl) &&
  (decl.hasModifier(SyntaxKind.PrivateKeyword) || decl.hasModifier(SyntaxKind.ProtectedKeyword));

const membersOf = (def: Node): Map<string, MemberInfo> => {
  const type = def.getType();
  const members = new Map<string, MemberInfo>();
  for (const prop of type.getApparentProperties()) {
    const decls = prop.getDeclarations();
    // "#private" fields and TypeScript's internal unique-symbol keys
    // (__@brand@248) aren't API
    if (
      prop.getName().startsWith("#") ||
      /^__@.+@\d+$/.test(prop.getName()) ||
      decls.some(isNonPublic)
    ) {
      continue;
    }
    const typeText = prop
      .getTypeAtLocation(def)
      .getText(def, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
    members.set(prop.getName(), {
      name: prop.getName(),
      owner: ownerName(decls[0]),
      optional: prop.isOptional(),
      type: clipTo(typeText.replace(/ \| undefined$/, ""), MAX_MEMBER_TYPE),
      ...jsDocInfo(decls),
    });
  }
  return members;
};

// interfaces and type aliases referenced by the declarations, breadth first
const namedTypes = (decls: Node[], owned: (file: string) => boolean) => {
  const found = new Map<string, Node>();
  // a class's own members are diffed directly; following every method's
  // parameter types would bury the result, so only the constructor's are
  const queue: [Node, number][] = decls.flatMap((d): [Node, number][] =>
    Node.isClassDeclaration(d) ? d.getConstructors().map((c) => [c, 0]) : [[d, 0]],
  );
  for (const d of decls) {
    if (Node.isInterfaceDeclaration(d) || Node.isTypeAliasDeclaration(d) || Node.isClassDeclaration(d)) {
      const name = d.getName();
      if (name && isObjectish(d.getType())) found.set(name, d);
    }
  }
  while (queue.length > 0 && found.size < MAX_TYPES_PER_SYMBOL) {
    const [node, depth] = queue.shift()!;
    for (const ref of node.getDescendantsOfKind(SyntaxKind.TypeReference)) {
      const nameNode = ref.getTypeName();
      const id = Node.isQualifiedName(nameNode) ? nameNode.getRight() : nameNode;
      const name = id.getText();
      if (found.has(name)) continue;
      const symbol = id.getSymbol();
      for (const def of symbol ? resolveAlias(symbol).getDeclarations() : []) {
        if (!Node.isInterfaceDeclaration(def) && !Node.isTypeAliasDeclaration(def)) continue;
        if (!owned(def.getSourceFile().getFilePath()) || !isObjectish(def.getType())) continue;
        found.set(name, def);
        if (depth + 1 < MAX_TYPE_DEPTH) queue.push([def, depth + 1]);
        break;
      }
      if (found.size >= MAX_TYPES_PER_SYMBOL) break;
    }
  }
  return found;
};

const diffMembers = (
  typeName: string,
  oldDef: Node,
  newDef: Node,
  words: Set<string>,
  out: Map<string, MemberChange>,
) => {
  const before = membersOf(oldDef);
  const after = membersOf(newDef);
  // keyed by the declaring type so a member reached through several types
  // (UseQueryOptions, QueryObserverOptions, ...) is reported once
  const push = (owner: string, change: Omit<MemberChange, "type" | "mentioned">) => {
    const key = `${change.kind}:${owner}.${change.member}`;
    if (!out.has(key)) {
      out.set(key, { ...change, type: typeName, owner, mentioned: words.has(change.member) });
    }
  };

  for (const [name, m] of before) {
    const n = after.get(name);
    if (!n) {
      push(m.owner, { kind: "removed", member: name, from: m.type });
      continue;
    }
    if (normalize(m.type) !== normalize(n.type)) {
      push(m.owner, { kind: "type", member: name, from: m.type, to: n.type });
    }
    if (m.optional !== n.optional) {
      push(m.owner, {
        kind: "optionality",
        member: name,
        from: m.optional ? "optional" : "required",
        to: n.optional ? "optional" : "required",
      });
    }
    if ((m.default ?? "") !== (n.default ?? "") && n.default !== undefined) {
      push(m.owner, { kind: "default", member: name, from: m.default, to: n.default });
    }
    if (n.deprecated && !m.deprecated) {
      push(m.owner, { kind: "deprecated", member: name, to: n.deprecated });
    }
    if (n.description && normalizeDoc(m.description) !== normalizeDoc(n.description)) {
      push(m.owner, {
        kind: "description",
        member: name,
        from: m.description || undefined,
        to: n.description,
      });
    }
  }
  for (const [name, n] of after) {
    if (before.has(name)) continue;
    push(n.owner, {
      kind: "added",
      member: name,
      to: n.type,
      required: !n.optional,
    });
  }
};

const symbolText = (decls: Node[]) =>
  clipTo(decls.map(declarationText).join("\n"), MAX_SIGNATURE);

const diffSymbol = (
  imported: ImportedSymbol,
  oldV: Loaded,
  newV: Loaded,
  words: Set<string>,
): SymbolDiff => {
  const oldSym = oldV.modules.get(imported.module)?.(imported.name);
  const newSym = newV.modules.get(imported.module)?.(imported.name);
  const base = {
    ...imported,
    signatureChanged: false,
    members: [] as MemberChange[],
    typesOnlyOld: [] as string[],
    typesOnlyNew: [] as string[],
  };

  const oldDecls = oldSym ? resolveAlias(oldSym).getDeclarations() : [];
  const newDecls = newSym ? resolveAlias(newSym).getDeclarations() : [];
  if (oldDecls.length === 0 && newDecls.length === 0) {
    return { ...base, status: "unresolved" };
  }
  if (newDecls.length === 0) {
    return { ...base, status: "removed", old: symbolText(oldDecls) };
  }
  if (oldDecls.length === 0) {
    return { ...base, status: "added", new: symbolText(newDecls) };
  }

  const old = symbolText(oldDecls);
  const neu = symbolText(newDecls);
  const signatureChanged = normalize(old) !== normalize(neu);

  const oldTypes = namedTypes(oldDecls, oldV.owned);
  const newTypes = namedTypes(newDecls, newV.owned);
  const changes = new Map<string, MemberChange>();
  for (const [name, oldDef] of oldTypes) {
    const newDef = newTypes.get(name);
    if (newDef) diffMembers(name, oldDef, newDef, words, changes);
  }

  const oldDoc = jsDocInfo(oldDecls);
  const newDoc = jsDocInfo(newDecls);
  const deprecated = newDoc.deprecated && !oldDoc.deprecated ? newDoc.deprecated : undefined;
  const members = Array.from(changes.values());

  return {
    ...base,
    status: signatureChanged || members.length > 0 || deprecated ? "changed" : "unchanged",
    signatureChanged,
    old: signatureChanged ? old : undefined,
    new: signatureChanged ? neu : undefined,
    deprecated,
    members,
    typesOnlyOld: [...oldTypes.keys()].filter((n) => !newTypes.has(n)),
    typesOnlyNew: [...newTypes.keys()].filter((n) => !oldTypes.has(n)),
  };
};

const exactVersion = async (projectRoot: string, pkg: string, spec: string) => {
  if (semver.valid(spec)) return spec;
  const version = resolveVersion(await getPackument(projectRoot, pkg), spec);
  if (!version) throw new Error(`No version of ${pkg} matches '${spec}'`);
  return version;
};

export const diffApi = async (
  projectRoot: string,
  pkg: string,
  from?: string,
  to?: string,
  options: { imports?: ProjectImports } = {},
): Promise<ApiDiff> => {
  const installed = installedVersion(projectRoot, pkg);
  const fromSpec = from ?? installed;
  if (!fromSpec) {
    throw new Error(`${pkg} is not installed; pass the version to diff from`);
  }
  const [fromVersion, toVersion] = await Promise.all([
    exactVersion(projectRoot, pkg, fromSpec),
    exactVersion(projectRoot, pkg, to ?? "latest"),
  ]);

  const imports =
    options.imports ?? collectImports(projectRoot, [pkg]).get(pkg)!;
  const [oldVersion, newVersion] = await Promise.all([
    locateVersion(projectRoot, pkg, fromVersion),
    locateVersion(projectRoot, pkg, toVersion),
  ]);

  const notes: string[] = [];
  for (const v of [oldVersion, newVersion]) {
    if (!v.hasTypes) {
      notes.push(
        `${pkg}@${v.version} has no type declarations and no @types/${pkg} was found; its symbols can't be compared.`,
      );
    }
  }

  const specifiers = Array.from(new Set(imports.symbols.map((s) => s.module)));
  const oldLoaded = loadVersion(projectRoot, pkg, oldVersion, specifiers);
  const newLoaded = loadVersion(projectRoot, pkg, newVersion, specifiers);

  const unresolvedModules = specifiers.flatMap((module) => {
    const inOld = !oldLoaded.modules.get(module);
    const inNew = !newLoaded.modules.get(module);
    if (!inOld && !inNew) return [];
    return [{ module, in: inOld && inNew ? "both" : inOld ? "from" : "to" } as const];
  });

  const symbols = imports.symbols.map((s) => {
    try {
      return diffSymbol(s, oldLoaded, newLoaded, imports.words);
    } catch (e) {
      notes.push(`Could not compare ${s.name}: ${e instanceof Error ? e.message : String(e)}`);
      return {
        ...s,
        status: "unresolved" as const,
        signatureChanged: false,
        members: [],
        typesOnlyOld: [],
        typesOnlyNew: [],
      };
    }
  });

  const order: SymbolStatus[] = ["removed", "changed", "added", "unresolved", "unchanged"];
  return {
    package: pkg,
    from: fromVersion,
    to: toVersion,
    fromSource: oldVersion.source,
    toSource: newVersion.source,
    importingFiles: imports.files,
    importSites: imports.sites,
    unresolvedModules,
    symbols: symbols.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)),
    notes,
  };
};

// ---- text output ----

const sites = (s: ImportedSymbol) =>
  s.importedAt.length > 2
    ? `${s.importedAt.slice(0, 2).join(", ")} +${s.importedAt.length - 2}`
    : s.importedAt.join(", ");

const MAX_PRINTED_MEMBERS = 15;
const unique = (xs: string[]) => Array.from(new Set(xs));
const list = (xs: string[], max: number) =>
  `${xs.slice(0, max).join(", ")}${xs.length > max ? `, … (+${xs.length - max})` : ""}`;
const star = (c: MemberChange) => (c.mentioned ? " [mentioned in project]" : "");
const oneLine = (text: string | undefined, max = 240) =>
  clipTo((text ?? "").replace(/\s+/g, " ").trim(), max);

export const printApiDiff = (d: ApiDiff) => {
  console.log(
    `# ${d.package} ${d.from} (${d.fromSource}) → ${d.to} (${d.toSource})`,
  );
  const changedCount = d.symbols.filter((s) => s.status !== "unchanged").length;
  console.log(
    `${d.symbols.length} imported name(s) in ${d.importingFiles.length} file(s); ${changedCount} differ.`,
  );
  for (const n of d.notes) console.log(`note: ${n}`);

  if (d.unresolvedModules.length > 0) {
    console.log(`\n## Import paths that don't resolve`);
    for (const m of d.unresolvedModules) {
      const where = m.in === "both" ? "either version" : m.in === "to" ? d.to : d.from;
      console.log(`- "${m.module}" in ${where}`);
    }
  }

  const all = d.symbols.flatMap((s) => s.members.map((m) => ({ s, m })));

  // 1. removed
  const removedSymbols = d.symbols.filter((s) => s.status === "removed");
  const removedMembers = all.filter(({ m }) => m.kind === "removed");
  console.log(`\n## Removed`);
  if (removedSymbols.length === 0 && removedMembers.length === 0) console.log("none");
  for (const s of removedSymbols) {
    console.log(`- ${s.name} from "${s.module}" (${sites(s)})`);
  }
  // grouped per type so members added alongside (likely renames) sit next
  // to the removed ones; members the project mentions first
  for (const s of d.symbols) {
    const byType = new Map<string, MemberChange[]>();
    for (const m of s.members) {
      if (m.kind === "removed") byType.set(m.type, [...(byType.get(m.type) ?? []), m]);
    }
    const groups = [...byType].sort(
      ([, a], [, b]) => Number(b.some((m) => m.mentioned)) - Number(a.some((m) => m.mentioned)),
    );
    for (const [type, removed] of groups) {
      console.log(`- ${s.name} › ${type}`);
      const sorted = removed.sort((a, b) => Number(b.mentioned) - Number(a.mentioned));
      console.log(
        `    removed: ${sorted.map((m) => (m.mentioned ? `${m.member}* (${oneLine(m.from, 60)})` : m.member)).join(", ")}`,
      );
      const added = unique(
        s.members.filter((a) => a.kind === "added" && a.type === type).map((a) => a.member),
      );
      if (added.length > 0) console.log(`    added:   ${list(added, 15)}`);
    }
  }
  if (removedMembers.some((r) => r.m.mentioned)) {
    console.log("  (* = name appears in a file that imports the package)");
  }

  // 2. behavior
  const behavior = all.filter(({ m }) => BEHAVIOR_KINDS.includes(m.kind));
  const deprecatedSymbols = d.symbols.filter((s) => s.deprecated);
  console.log(`\n## !! Compiles but may behave differently (check each use)`);
  const shown = behavior.filter(({ m }) => isRelevantBehavior(m));
  const hidden = behavior.filter(({ m }) => !isRelevantBehavior(m));
  if (shown.length === 0 && deprecatedSymbols.length === 0) console.log("none found in the type declarations");
  for (const s of deprecatedSymbols) {
    console.log(`- [deprecated] ${s.name}: ${oneLine(s.deprecated)}`);
  }
  for (const { s, m } of shown.sort((a, b) => Number(b.m.mentioned) - Number(a.m.mentioned))) {
    const where = `${s.name} › ${m.type}.${m.member}${star(m)}`;
    if (m.kind === "default") {
      console.log(`- [default] ${where}: ${m.from ?? "(undocumented)"} → ${m.to}`);
    } else if (m.kind === "deprecated") {
      console.log(`- [deprecated] ${where}: ${oneLine(m.to)}`);
    } else {
      console.log(`- [docs ${m.from ? "changed" : "added"}] ${where}`);
      console.log(
        m.from && m.to
          ? `    ${oneLine(docDelta(m.from, m.to), 320)}`
          : `    now: ${oneLine(m.to)}`,
      );
    }
  }
  const hiddenOf = (kind: MemberChangeKind) =>
    unique(hidden.filter(({ m }) => m.kind === kind).map(({ m }) => `${m.member}${m.kind === "default" ? `=${m.to}` : ""}`));
  const hiddenLines: [string, string[]][] = [
    ["deprecated, not mentioned in the project", hiddenOf("deprecated")],
    ["newly documented defaults (undocumented before, may be unchanged)", hiddenOf("default")],
    ["reworded/new docs, not mentioned in the project", hiddenOf("description")],
  ];
  for (const [label, names] of hiddenLines) {
    if (names.length > 0) console.log(`- ${names.length} ${label}: ${list(names, 15)}`);
  }

  // 3. signatures and member types
  console.log(`\n## Signature changes`);
  const changed = d.symbols.filter(
    (s) => s.status === "changed" && (s.signatureChanged || s.members.some((m) => !BEHAVIOR_KINDS.includes(m.kind) && m.kind !== "removed")),
  );
  if (changed.length === 0) console.log("none");
  for (const s of changed) {
    console.log(`\n### ${s.name} from "${s.module}" (${sites(s)})`);
    if (s.signatureChanged) {
      console.log(`before:\n${s.old}\nafter:\n${s.new}`);
    }
    if (s.typesOnlyNew.length > 0) console.log(`new types in the signature: ${s.typesOnlyNew.join(", ")}`);
    if (s.typesOnlyOld.length > 0) console.log(`types no longer in the signature: ${s.typesOnlyOld.join(", ")}`);
    const typeChanges = s.members
      .filter((m) => m.kind === "type" || m.kind === "optionality")
      .sort((a, b) => Number(b.mentioned) - Number(a.mentioned));
    for (const m of typeChanges.slice(0, MAX_PRINTED_MEMBERS)) {
      console.log(
        `- ${m.type}.${m.member}${star(m)}: ${oneLine(m.from, 100)} → ${oneLine(m.to, 100)}`,
      );
    }
    if (typeChanges.length > MAX_PRINTED_MEMBERS) {
      console.log(`- (+${typeChanges.length - MAX_PRINTED_MEMBERS} more member type changes; --json for all)`);
    }
    const added = s.members.filter((m) => m.kind === "added");
    const required = unique(added.filter((m) => m.required).map((m) => `${m.type}.${m.member}`));
    const optional = unique(added.filter((m) => !m.required).map((m) => m.member));
    if (required.length > 0) console.log(`- new required members: ${list(required, 15)}`);
    if (optional.length > 0) console.log(`- new optional members: ${list(optional, 25)}`);
  }

  const added = d.symbols.filter((s) => s.status === "added");
  if (added.length > 0) {
    console.log(`\n## Only in ${d.to}: ${added.map((s) => s.name).join(", ")}`);
  }
  const unresolved = d.symbols.filter((s) => s.status === "unresolved");
  if (unresolved.length > 0) {
    console.log(`\n## Could not resolve in either version: ${unresolved.map((s) => s.name).join(", ")}`);
  }
  const unchanged = d.symbols.filter((s) => s.status === "unchanged");
  console.log(`\nUnchanged: ${unchanged.length > 0 ? unchanged.map((s) => s.name).join(", ") : "none"}`);
};

// exported for impact.ts: changes worth counting per symbol
export const summarizeSymbol = (s: SymbolDiff) => ({
  removed: s.status === "removed",
  changed: s.status === "changed",
  // missing from the old version or both, so nothing to compare against
  uncompared: s.status === "unresolved" || s.status === "added",
  behavior: !!s.deprecated || s.members.some(isRelevantBehavior),
  mentionedRemovals: unique(
    s.members.filter((m) => m.kind === "removed" && m.mentioned).map((m) => m.member),
  ),
});
