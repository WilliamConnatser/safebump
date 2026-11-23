import path from "path";
import type { Identifier, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

export const isImportNode = (node: Node) =>
  Node.isImportDeclaration(node) ||
  Node.isNamespaceImport(node) || // import * as foo from 'bar'
  Node.isImportClause(node) || // import foo from 'bar'
  Node.isImportEqualsDeclaration(node) || // import foo = require('bar')
  Node.isImportSpecifier(node);

export const allChildrenOfKindIdentifier = (node: Node): Identifier[] => {
  const ids = node.getDescendantsOfKind(SyntaxKind.Identifier);
  return Node.isIdentifier(node) ? [node, ...ids] : ids;
};

// the outermost statement containing the node, i.e. the child of the SourceFile
export const getSurroundingBlock = (node: Node): Node => {
  const ancestors = node.getAncestors();
  return ancestors[ancestors.length - 2] ?? node;
};

export type Block = {
  // "<relative path>:<start>-<end>", stable for a single analysis run
  id: string;
  name: string;
  kind: string;
  path: string;
  relPath: string;
  startLine: number;
  endLine: number;
  node: Node;
};

const blockName = (n: Node): string => {
  if (Node.isVariableStatement(n)) {
    return n
      .getDeclarations()
      .map((d) => d.getName())
      .join(", ");
  }
  if (Node.isImportDeclaration(n)) return `import "${n.getModuleSpecifierValue()}"`;
  if (Node.isExportAssignment(n)) return "export default";
  if (Node.isExportDeclaration(n)) return "export declaration";
  if ("getName" in n && typeof n.getName === "function") {
    const name = n.getName() as string | undefined;
    if (name) return name;
  }
  if (Node.isExpressionStatement(n)) {
    return n.getText().split("\n")[0]!.slice(0, 60);
  }
  return n.getKindName();
};

export const makeBlock = (projectRoot: string, n: Node): Block => {
  const filePath = n.getSourceFile().getFilePath();
  const relPath = path.relative(projectRoot, filePath);
  const startLine = n.getStartLineNumber();
  const endLine = n.getEndLineNumber();
  return {
    id: `${relPath}:${startLine}-${endLine}`,
    name: blockName(n),
    kind: n.getKindName(),
    path: filePath,
    relPath,
    startLine,
    endLine,
    node: n,
  };
};

export const blockAt = (
  projectRoot: string,
  sourceFile: SourceFile,
  line: number,
  column: number,
) => {
  const lineCount = sourceFile.getEndLineNumber();
  if (line < 1 || line > lineCount) return undefined;
  const pos = sourceFile.compilerNode.getPositionOfLineAndCharacter(
    line - 1,
    Math.max(column - 1, 0),
  );
  const node = sourceFile.getDescendantAtPos(pos);
  if (!node) return undefined;
  return makeBlock(projectRoot, getSurroundingBlock(node));
};

export const isFromPackage = (specifier: string, pkg: string) =>
  specifier === pkg || specifier.startsWith(`${pkg}/`);

// names in the block that are imported from `pkg`
export const packageImportsUsed = (block: Block, pkg: string) => {
  if (Node.isImportDeclaration(block.node)) {
    return isFromPackage(block.node.getModuleSpecifierValue(), pkg)
      ? block.node.getNamedImports().map((i) => i.getName())
      : [];
  }
  const names = new Set<string>();
  for (const id of allChildrenOfKindIdentifier(block.node)) {
    for (const decl of id.getSymbol()?.getDeclarations() ?? []) {
      if (!isImportNode(decl)) continue;
      const importDecl = decl.getFirstAncestorByKind(
        SyntaxKind.ImportDeclaration,
      );
      if (
        importDecl &&
        isFromPackage(importDecl.getModuleSpecifierValue(), pkg)
      ) {
        names.add(id.getText());
      }
    }
  }
  return Array.from(names);
};

// declarations in the block whose references are worth following
const referenceableDeclarations = (n: Node): Node[] => {
  if (Node.isVariableStatement(n)) return n.getDeclarations();
  if (Node.isExportAssignment(n) || Node.isExpressionStatement(n)) return [];
  if (Node.isReferenceFindable(n)) return [n];
  return [];
};

// blocks outside `block` (and outside node_modules) that reference it
export const referencingBlocks = (projectRoot: string, block: Block) => {
  const found = new Map<string, Block>();
  for (const decl of referenceableDeclarations(block.node)) {
    if (!Node.isReferenceFindable(decl)) continue;
    for (const ref of decl.findReferencesAsNodes()) {
      if (ref.getSourceFile().isInNodeModules()) continue;
      const refBlock = makeBlock(projectRoot, getSurroundingBlock(ref));
      if (refBlock.id === block.id || Node.isImportDeclaration(refBlock.node)) {
        continue;
      }
      found.set(refBlock.id, refBlock);
    }
  }
  return Array.from(found.values());
};
