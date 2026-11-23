import path from "path";
import type {
  Node as MorphNode,
  ObjectLiteralExpression,
  SourceFile,
  Symbol as MorphSymbol,
  Type,
  TypeChecker,
} from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { readPackageJson } from "../packages";
import type { ApiDiff, MemberChange } from "./apidiff";
import { diffApi, normalizeDoc, ownerName } from "./apidiff";
import { findPackageDir } from "./analyze";
import { isFromPackage } from "./ast";
import { initializeAst } from "./index";

// A changed default compiles and passes type-checking everywhere; it bites
// exactly where the option is *not* written. This finds those places: object
// literals typed (contextually) as the option's owner that leave it out.

// parent-omitted: the property holding the option's object is left out
// entirely (`text` for verbosity); the default applies only if the package
// fills it in anyway, as server-side defaults do
export type DefaultSiteStatus = "omitted" | "spread-unknown" | "parent-omitted" | "set";

export type DefaultSite = {
  file: string;
  line: number;
  column: number;
  // what the literal is passed to, e.g. client.responses.create
  call: string;
  status: DefaultSiteStatus;
  // the literal omits this property, whose type holds the option
  // (e.g. `text` for ResponseTextConfig.verbosity)
  via?: string;
};

export type DefaultChange = {
  // the interface/alias declaring the option
  owner: string;
  member: string;
  // "@default" tag changed, or the docs newly state a default
  source: "@default" | "docs";
  // false when nothing was documented before: may be unchanged
  changed: boolean;
  oldDefault?: string;
  newDefault?: string;
  evidence: string;
  // every site but "set"
  sites: DefaultSite[];
  setCount: number;
  // sites in test files, not listed (mocks and fixtures, mostly)
  testSites: number;
};

export type DefaultReliance = {
  package: string;
  from: string;
  to: string;
  changes: DefaultChange[];
  notes: string[];
};

// ---- default changes from the API diff ----

// "Defaults to true", "The default is medium", "Default: 10", "by default";
// not "typically defaulting to", which describes something else's default
const STATES_DEFAULT = /\b(defaults? to|default (value )?is|default:|by default)\b/i;
const VALUE_PATTERNS = [
  /\bdefaults? to\s+((?:[^.;,]|[.,]\S)+)/i,
  /\bdefault (?:value )?is\s+((?:[^.;,]|[.,]\S)+)/i,
  /\bdefault:\s*((?:[^.;,]|[.,]\S)+)/i,
];

const sentences = (doc: string | undefined) =>
  doc ? normalizeDoc(doc).split(/(?<=[.!?])\s+/).filter(Boolean) : [];

export const parseDefault = (sentence: string) => {
  for (const re of VALUE_PATTERNS) {
    const m = re.exec(sentence);
    if (!m) continue;
    const value = m[1]!
      .replace(/\s+(when|if|unless|for|on|in|which|so|but|and)\b.*$/i, "")
      .replace(/^["'`]|["'`]$/g, "")
      .trim();
    if (value) return value;
  }
  return undefined;
};

// "1200 seconds (20 minutes)" and "1,200 seconds"
const sameValue = (a: string, b: string) => {
  const canon = (v: string) => v.replace(/\([^)]*\)/g, "").replace(/(\d),(\d)/g, "$1$2").replace(/\s+/g, " ").trim().toLowerCase();
  return canon(a) === canon(b);
};

const stated = (doc: string | undefined) => sentences(doc).filter((s) => STATES_DEFAULT.test(s));

const fromDefaultTag = (m: MemberChange): Omit<DefaultChange, "sites" | "setCount" | "testSites"> => ({
  owner: m.owner ?? m.type,
  member: m.member,
  source: "@default",
  changed: m.from !== undefined,
  oldDefault: m.from,
  newDefault: m.to,
  evidence: `@default ${m.from ?? "(not documented)"} → ${m.to}`,
});

const fromDocs = (m: MemberChange): Omit<DefaultChange, "sites" | "setCount" | "testSites"> | undefined => {
  const before = new Set(sentences(m.from));
  const added = stated(m.to).filter((s) => !before.has(s));
  if (added.length === 0) return undefined;
  const oldDefault = stated(m.from).map(parseDefault).find(Boolean);
  const newDefault = added.map(parseDefault).find(Boolean);
  // reworded but the same value
  if (oldDefault && newDefault && sameValue(oldDefault, newDefault)) return undefined;
  return {
    owner: m.owner ?? m.type,
    member: m.member,
    source: "docs",
    changed: true,
    oldDefault,
    newDefault,
    evidence: added.join(" "),
  };
};

export const defaultChanges = (diff: ApiDiff) => {
  const found = new Map<string, Omit<DefaultChange, "sites" | "setCount" | "testSites">>();
  for (const m of diff.symbols.flatMap((s) => s.members)) {
    const key = `${m.owner ?? m.type}.${m.member}`;
    const change =
      m.kind === "default" ? fromDefaultTag(m) : m.kind === "description" ? fromDocs(m) : undefined;
    if (!change) continue;
    // an @default tag beats prose about the same member
    if (!found.has(key) || change.source === "@default") found.set(key, change);
  }
  return Array.from(found.values());
};

// ---- where the project relies on them ----

const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(\/__tests__\/)|(^|\/)tests?\//;
const MAX_VIA_PROPS = 200;

const packageOfFile = (file: string) =>
  /.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file)?.[1];

// the package, its @types and its dependencies (react-query's options are
// declared in @tanstack/query-core)
const ownedPackages = (projectRoot: string, pkg: string) => {
  const dir = findPackageDir(projectRoot, pkg);
  const deps = dir ? Object.keys(readPackageJson(dir)?.dependencies ?? {}) : [];
  const types = `@types/${pkg.startsWith("@") ? pkg.slice(1).replace("/", "__") : pkg}`;
  return new Set([pkg, types, ...deps]);
};

const unionParts = (t: Type): Type[] =>
  t.isUnion() ? t.getUnionTypes().filter((u) => !u.isUndefined() && !u.isNull()) : [t];

type Target = { owner: string; member: string };

const declaresMember = (
  t: Type,
  target: Target,
  owned: (file: string) => boolean,
): boolean =>
  unionParts(t).some((part) => {
    const prop = part.getProperty(target.member);
    return !!prop?.getDeclarations().some(
      (d) => ownerName(d) === target.owner && owned(d.getSourceFile().getFilePath()),
    );
  });

type Presence = "set" | "maybe" | "absent";

// does the literal write `name`, directly or through a spread?
const presence = (literal: ObjectLiteralExpression, name: string): Presence => {
  if (literal.getProperty(name)) return "set";
  let result: Presence = "absent";
  for (const spread of literal.getChildrenOfKind(SyntaxKind.SpreadAssignment)) {
    const t = spread.getExpression().getType();
    if (t.isAny() || t.isUnknown() || t.isTypeParameter()) return "maybe";
    const parts = unionParts(t);
    const props = parts.map((p) => p.getProperty(name));
    // `...(cond ? { x } : {})` sets it only sometimes
    if (props.length > 0 && props.every((p) => p && !p.isOptional())) return "set";
    if (props.some(Boolean)) result = "maybe";
  }
  return result;
};

// climb out of nested literals/casts to what the value is handed to
const describeUse = (node: MorphNode): string => {
  let current = node;
  for (;;) {
    const parent = current.getParent();
    if (!parent) return "?";
    if (
      Node.isPropertyAssignment(parent) ||
      Node.isObjectLiteralExpression(parent) ||
      Node.isArrayLiteralExpression(parent) ||
      Node.isParenthesizedExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isSatisfiesExpression(parent) ||
      Node.isSpreadAssignment(parent) ||
      Node.isConditionalExpression(parent) ||
      Node.isBinaryExpression(parent)
    ) {
      current = parent;
      continue;
    }
    if (Node.isCallExpression(parent)) return parent.getExpression().getText().replace(/\s+/g, "");
    if (Node.isNewExpression(parent)) return `new ${parent.getExpression().getText()}`;
    if (Node.isVariableDeclaration(parent)) {
      const typeNode = parent.getTypeNode()?.getText();
      return `const ${parent.getName()}${typeNode ? `: ${typeNode}` : ""}`;
    }
    if (Node.isReturnStatement(parent) || Node.isArrowFunction(parent)) return "returned value";
    if (Node.isPropertyDeclaration(parent)) return `property ${parent.getName()}`;
    return parent.getKindName();
  }
};

// `const opts = {...}; useQuery(opts)`: the literal has no contextual type,
// the argument does
const typeThroughVariable = (literal: ObjectLiteralExpression, checker: TypeChecker) => {
  const decl = literal.getParentIfKind(SyntaxKind.VariableDeclaration);
  const name = decl?.getNameNode();
  if (!decl || !name || !Node.isIdentifier(name) || decl.getTypeNode()) return undefined;
  const symbol = name.getSymbol();
  for (const id of literal.getSourceFile().getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id === name || id.getText() !== name.getText() || id.getSymbol() !== symbol) continue;
    const call = id.getParent();
    if (!(Node.isCallExpression(call) || Node.isNewExpression(call))) continue;
    if (!call.getArguments().includes(id)) continue;
    const type = checker.getContextualType(id);
    if (type) {
      const callee = call.getExpression().getText().replace(/\s+/g, "");
      return { type, call: Node.isNewExpression(call) ? `new ${callee}` : callee };
    }
  }
  return undefined;
};

const importsPackage = (sf: SourceFile, pkg: string) =>
  [...sf.getImportDeclarations(), ...sf.getExportDeclarations()].some((d) => {
    const spec = d.getModuleSpecifierValue();
    return !!spec && isFromPackage(spec, pkg);
  });

// `...(cond ? { a } : {})`: partial by design, the enclosing literal counts
const isSpreadOperand = (literal: ObjectLiteralExpression) => {
  let current: MorphNode = literal;
  for (;;) {
    const parent = current.getParent();
    if (!parent) return false;
    if (Node.isSpreadAssignment(parent) || Node.isSpreadElement(parent)) return true;
    const passesThrough =
      Node.isParenthesizedExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isSatisfiesExpression(parent) ||
      (Node.isConditionalExpression(parent) && parent.getCondition() !== current) ||
      (Node.isBinaryExpression(parent) && parent.getRight() === current);
    if (!passesThrough) return false;
    current = parent;
  }
};

type Scan = {
  site: DefaultSite;
  test: boolean;
};

const scanLiteral = (
  projectRoot: string,
  literal: ObjectLiteralExpression,
  checker: TypeChecker,
  targets: Target[],
  owned: (file: string) => boolean,
  out: Map<string, Scan[]>,
) => {
  if (isSpreadOperand(literal)) return;
  let type = checker.getContextualType(literal);
  let call: string | undefined;
  if (!type) {
    const viaVar = typeThroughVariable(literal, checker);
    if (!viaVar) return;
    ({ type, call } = viaVar);
  }
  const file = path.relative(projectRoot, literal.getSourceFile().getFilePath());
  const test = TEST_FILE.test(file);
  const { line, column } = literal.getSourceFile().getLineAndColumnAtPos(literal.getStart());
  const where = { file, line, column, call: call ?? describeUse(literal) };
  const record = (t: Target, status: DefaultSiteStatus, via?: string) => {
    const key = `${t.owner}.${t.member}`;
    out.set(key, [...(out.get(key) ?? []), { site: { ...where, status, ...(via ? { via } : {}) }, test }]);
  };

  // only literals typed by something the package declares
  const parts = unionParts(type);
  const fromPackage = parts.some((p) =>
    (p.getAliasSymbol() ?? p.getSymbol())
      ?.getDeclarations()
      .some((d) => owned(d.getSourceFile().getFilePath())),
  );
  const candidateProps = fromPackage
    ? new Map(
        parts
          .flatMap((p) => p.getProperties())
          .slice(0, MAX_VIA_PROPS)
          .map((p): [string, MorphSymbol] => [p.getName(), p]),
      )
    : new Map<string, MorphSymbol>();

  for (const t of targets) {
    if (declaresMember(type, t, owned)) {
      const p = presence(literal, t.member);
      record(t, p === "set" ? "set" : p === "maybe" ? "spread-unknown" : "omitted");
      continue;
    }
    // one level down: `text` left out entirely still means
    // ResponseTextConfig.verbosity takes its default
    for (const [name, prop] of candidateProps) {
      if (!prop.isOptional()) continue;
      const propType = prop.getTypeAtLocation(literal);
      if (!declaresMember(propType, t, owned)) continue;
      const p = presence(literal, name);
      if (p === "absent") record(t, "parent-omitted", name);
      break;
    }
  }
};

export const findDefaultReliance = async (
  projectRoot: string,
  pkg: string,
  from?: string,
  to?: string,
): Promise<DefaultReliance> => {
  const diff = await diffApi(projectRoot, pkg, from, to);
  const found = defaultChanges(diff);
  const notes = [...diff.notes];
  if (found.length === 0) {
    return { package: pkg, from: diff.from, to: diff.to, changes: [], notes };
  }

  const project = initializeAst(projectRoot);
  const checker = project.getTypeChecker();
  const ownedNames = ownedPackages(projectRoot, pkg);
  const owned = (file: string) => {
    const owner = packageOfFile(file);
    return !!owner && ownedNames.has(owner);
  };
  const targets = found.map(({ owner, member }) => ({ owner, member }));

  // literals handed to the package live in the files importing it; options
  // built elsewhere and passed through the project's own wrappers are missed
  const files = project
    .getSourceFiles()
    .filter((sf) => !sf.isInNodeModules() && !sf.isDeclarationFile() && importsPackage(sf, pkg));
  if (files.length === 0) notes.push(`No source file imports ${pkg}.`);

  const scans = new Map<string, Scan[]>();
  for (const sf of files) {
    for (const literal of sf.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
      scanLiteral(projectRoot, literal, checker, targets, owned, scans);
    }
  }

  const changes = found.map((c): DefaultChange => {
    const seen = new Set<string>();
    const all = (scans.get(`${c.owner}.${c.member}`) ?? []).filter(({ site: s }) => {
      const key = `${s.file}:${s.line}:${s.column}:${s.status}:${s.via ?? ""}`;
      return !seen.has(key) && !!seen.add(key);
    });
    const live = all.filter((s) => !s.test);
    return {
      ...c,
      sites: live.filter((s) => s.site.status !== "set").map((s) => s.site),
      setCount: live.filter((s) => s.site.status === "set").length,
      testSites: all.length - live.length,
    };
  });

  // changed defaults with sites first, newly documented ones last
  changes.sort(
    (a, b) =>
      Number(b.changed) - Number(a.changed) ||
      b.sites.length - a.sites.length ||
      a.owner.localeCompare(b.owner),
  );
  return { package: pkg, from: diff.from, to: diff.to, changes, notes };
};

// ---- text output ----

const clip = (text: string, max = 300) =>
  text.length > max ? `${text.slice(0, max)} …` : text;

const list = (xs: string[], max = 3) =>
  `${xs.slice(0, max).join(", ")}${xs.length > max ? ` +${xs.length - max}` : ""}`;

const suggestion = (c: DefaultChange, s: DefaultSite) => {
  const pin = c.oldDefault ? `\`${c.member}: ${c.oldDefault}\`` : undefined;
  if (s.status === "spread-unknown") {
    return `a spread may set ${c.member}; check it, else set ${pin ?? `\`${c.member}\``} explicitly`;
  }
  return pin
    ? `to keep the old behavior, set ${pin} here`
    : `old default not documented: decide and set \`${c.member}\` explicitly`;
};

export const printDefaultReliance = (r: DefaultReliance) => {
  console.log(`# Changed defaults: ${r.package} ${r.from} → ${r.to}`);
  for (const n of r.notes) console.log(`note: ${n}`);
  const changed = r.changes.filter((c) => c.changed);
  const newlyDocumented = r.changes.filter((c) => !c.changed);
  const omitted = changed.reduce((n, c) => n + c.sites.filter((s) => s.status === "omitted").length, 0);
  console.log(
    `${changed.length} changed default(s); ${omitted} site(s) leave the option out and silently get the new default.`,
  );
  if (r.changes.length === 0) {
    console.log("No documented default changed on the API the project imports.");
    return;
  }

  for (const c of changed) {
    console.log(`\n## ${c.owner}.${c.member}: ${c.oldDefault ?? "(not documented)"} → ${c.newDefault ?? "(see evidence)"}`);
    console.log(`evidence (${c.source}): ${clip(c.evidence)}`);
    const direct = c.sites.filter((s) => s.status !== "parent-omitted");
    const parentOmitted = c.sites.filter((s) => s.status === "parent-omitted");
    if (direct.length === 0) console.log("no site leaves it out");
    for (const s of direct) {
      console.log(`- ${s.file}:${s.line} ${s.call} [${s.status}]`);
      console.log(`    ${suggestion(c, s)}`);
    }
    if (parentOmitted.length > 0) {
      const parents = Array.from(new Set(parentOmitted.map((s) => s.via))).join("/");
      console.log(
        `- \`${parents}\` itself is left out at ${parentOmitted.length} site(s): ${list(parentOmitted.map((s) => `${s.file}:${s.line}`))}`,
      );
      console.log(`    matters only if ${c.member}'s default applies without it (server-side defaults do)`);
    }
    const extra = [
      c.setCount > 0 ? `set explicitly at ${c.setCount} site(s)` : "",
      c.testSites > 0 ? `${c.testSites} site(s) in tests not listed` : "",
    ].filter(Boolean);
    if (extra.length > 0) console.log(extra.join("; "));
  }

  if (newlyDocumented.length > 0) {
    console.log(`\n## Newly documented defaults (undocumented before; may be unchanged)`);
    for (const c of newlyDocumented) {
      const direct = c.sites.filter((s) => s.status !== "parent-omitted");
      const where = direct.length > 0 ? `: left out at ${list(direct.map((s) => `${s.file}:${s.line}`))}` : "";
      console.log(`- ${c.owner}.${c.member} = ${c.newDefault ?? "?"}${where}`);
    }
  }
};
