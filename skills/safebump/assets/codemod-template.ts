// A safebump codemod: one mechanical change applied across the whole project.
// Copy this file somewhere outside src/ (e.g. .safebump/codemods/), edit it,
// then run:
//   safebump codemod <file> --dry-run   # review the diffs
//   safebump codemod <file>             # apply, then run `safebump tsc`
//
// Return true when the file changed. Only use what's passed in `api`;
// ts-morph is supplied by safebump, so don't import it.
//
// Example: react-query v4 -> v5, useQuery(key, fn, opts) -> useQuery({ queryKey, queryFn, ...opts })

import type { SourceFile } from "ts-morph";

type Api = {
  Node: typeof import("ts-morph").Node;
  SyntaxKind: typeof import("ts-morph").SyntaxKind;
};

export default function transform(file: SourceFile, { Node, SyntaxKind }: Api) {
  // Collect first, then edit in reverse document order: replacing a node
  // invalidates the nodes inside it, and reverse order handles inner calls
  // before the calls that contain them.
  const calls = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => call.getExpression().getText() === "useQuery")
    .reverse();

  let changed = false;
  for (const call of calls) {
    const [key, fn, options] = call.getArguments();
    // already migrated: a single object argument
    if (!key || Node.isObjectLiteralExpression(key)) continue;

    const props = [`queryKey: ${key.getText()}`];
    if (fn) props.push(`queryFn: ${fn.getText()}`);
    if (options && Node.isObjectLiteralExpression(options)) {
      props.push(...options.getProperties().map((p) => p.getText()));
    } else if (options) {
      props.push(`...${options.getText()}`);
    }

    const typeArgs = call.getTypeArguments().map((t) => t.getText());
    call.replaceWithText(
      `${call.getExpression().getText()}${typeArgs.length ? `<${typeArgs.join(", ")}>` : ""}({ ${props.join(", ")} })`,
    );
    changed = true;
  }

  // run the project's formatter afterwards; codemods don't preserve layout
  return changed;
}
