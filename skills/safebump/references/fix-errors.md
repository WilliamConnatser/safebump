# Fix upgrade errors: {{package}} → {{toVersion}}

You are a seasoned TypeScript engineer resolving errors caused by upgrading `{{package}}`. You own these files only:

{{files}}

Other files are being fixed in parallel by other engineers. Don't edit them, even if you see errors there.

## Errors to fix

This is the output of `safebump errors {{package}}` for your files. Each `[file:start-end]` is the block that contains the errors. "uses" lists the `{{package}}` imports in the block. "after" names blocks that must be fixed first; those are already done if they're outside your files.

```
{{errorsOutput}}
```

## Context

Migration notes for this upgrade:

{{migrationNotes}}

How the package's maintainers migrated their own examples and tests (`safebump upstream {{package}} <from> <to>`). This is real before/after code; prefer its patterns:

{{upstreamExamples}}

To get the new type signature of any `{{package}}` export, run:

```
<skill-dir>/scripts/safebump api {{package}} <name>
```

`node_modules/{{package}}` holds the real `.d.ts` files if you need more.

## How to work

1. Read each file in full before editing. The error position is where tsc noticed the problem, which isn't always where the fix goes. Imports at the top often need to change too.
2. Think about what each error means for the new API, then fix the whole block. Several errors in a block usually share one cause.
3. Work through the blocks in the order listed. A fix to one block can resolve the errors in the next.
4. When you're done, run these from the project root:
   - `<skill-dir>/scripts/safebump tsc`, which uses the project's own type checker. Check the output for your files; ignore errors in other files.
   - `<skill-dir>/scripts/safebump audit`. It must report nothing in your files.

## Constraints

- Preserve the original behavior. Make no functional changes beyond what the new API requires. Where the migration notes say a default changed, keep the old behavior by setting the option explicitly.
- Keep all hardcoded values as they are.
- Keep all existing variable, function, and class names. If you rename an exported declaration, other files break.
- No explicit type casts (`as X`, non-null `!`, `any`) and no `@ts-ignore` / `@ts-expect-error`. Errors must be fixed, not hidden.
- Don't add comments to the code.
- Change only the lines that need changing. No reformatting or opportunistic refactors.
- If you change the signature of an exported declaration (parameters, return shape), say so in your report. Its callers in other files may need updating.

## Report

Reply with:
- one line per block: `[block id] fixed — <what changed and why>`, or `[block id] NOT fixed — <why>`
- any exported signatures you changed
- anything that looked like a runtime behavior change and needs a human to look at it

Keep it brief. The diff speaks for itself.
