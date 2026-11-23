# Migration research: {{package}} {{fromVersion}} → {{toVersion}}

You are researching a dependency upgrade so another engineer can fix the code it breaks. Do not edit any files.

## What the project uses

This is the output of `safebump api-diff {{package}} {{fromVersion}} {{toVersion}}`. It covers only the names this project imports:
- removed and added members of option and result types
- signature changes
- changed `@default` values and deprecations ("may behave differently")

Use it to focus the research. Every removed name needs a documented replacement, and every "may behave differently" entry needs a verdict.

```
{{apiDiffOutput}}
```

## Sources, in order of preference

1. A migration or upgrade guide for this major version. Docs sites often render pages client-side and fetch poorly. The markdown source in the repo is more reliable: search it with `gh search code --repo <owner>/<repo> migrating` or `gh api repos/<owner>/<repo>/contents/docs`, then fetch `https://raw.githubusercontent.com/<owner>/<repo>/<default-branch>/<path>`.
2. The release notes on the repository's GitHub releases page for every major and minor release between the two versions. Use `gh release list` and `gh release view <tag> --repo <owner>/<repo>` if `gh` is available.
3. Changelog files shipped in the package (listed under "docs in package" above).
4. The package's `.d.ts` files in `node_modules/{{package}}`, as a last resort for renames.

Read primary sources only. Skip blog posts and Q&A sites unless nothing else covers a change.

## What to return

First, answer these three questions. Each one changes how the upgrade is done:

1. **Official migration tool:** is there a codemod or migration command for this upgrade? Examples: `ng update`, `nx migrate`, `npx @next/codemod`, `npx storybook automigrate`, `npx codemod <recipe>`. Give the exact command and what it covers.
2. **Upgrade path:** does the guide require intermediate versions, such as one major at a time or a specific minor before the next major? List the hops.
3. **Packages that must move together:** companion packages the guide says to upgrade at the same time, such as plugins, adapters, the CLI or `@types`. Also any new peer dependencies.

Then give a compact list of the breaking changes **that affect the names this project uses**, and nothing else. For each one:

- **Old:** the old usage, as a short code snippet
- **New:** the new usage, as a short code snippet
- **Notes:** caveats. Say whether the change is runtime-only, meaning tsc will not catch it: changed defaults, renamed options in untyped config, behavior changes.
- **Source:** the URL or file you got it from

Then add a short list headed **Runtime-only changes to grep for**: changes the type checker can't catch, each with a search pattern. Give particular attention to names that still exist but changed meaning, such as a flag or option that kept its name while its semantics moved to a new name.

Leave out changes to APIs the project doesn't import. If you couldn't find documentation for a removed name, say so plainly rather than guessing. Stay under about 800 words.
