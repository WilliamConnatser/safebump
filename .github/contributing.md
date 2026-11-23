# Contributing

The repo has two parts:

- **The published skill** is in [skills/safebump](../skills/safebump). It holds `SKILL.md`, `references/` (prompts and docs) and `assets/` (templates, the migration-tools registry). Its `scripts/safebump.mjs` is a **generated**, minified bundle; don't edit it by hand. It also includes `LICENSE` and `THIRD_PARTY_NOTICES.md`, because the folder gets copied into other repos on its own.
- **The CLI source** is in [cli/](../cli), in TypeScript. It's never installed with the skill.

## Developing the CLI

```bash
cd cli
npm install
npm run typecheck
npm run dev -- doctor --root ../examples/react-query-v4   # run from source with tsx
npm run build                                             # regenerate the bundle, LICENSE and notices
```

Commit the rebuilt `skills/safebump/` together with the source change. CI rebuilds it and fails if the committed bundle is out of date.

Try a change against the example project:

```bash
cd examples/react-query-v4
npm install
../../skills/safebump/scripts/safebump upgrade @tanstack/react-query@5.59.0
../../skills/safebump/scripts/safebump errors @tanstack/react-query
../../skills/safebump/scripts/safebump api-diff @tanstack/react-query 4.36.1 5.59.0
git checkout -- . && npm install
```

To try the whole skill end to end with any agent, link the working copy into the agent's skills directory:

```bash
ln -s "$PWD/skills/safebump" ~/.agents/skills/safebump
```

For Claude Code, link it into `~/.claude/skills/` instead. Then ask the agent to upgrade the example.

## Measuring changes

Judge every change to `SKILL.md`, the prompts or the scripts with the eval harness:

1. Run the same tasks before and after the change.
2. Compare the two runs with `npx tsx run.ts compare <before> <after>`.

See [evals/README.md](../evals/README.md), and start with one task.

## Migration notes

Bundled notes live in `skills/safebump/references/migrations/<pkg>/<from>-to-<to>.md`. Scoped names use `scope__name`, e.g. `tanstack__react-query`.

To add a note:
1. Find a good one. When an eval or real run passes, the agent's saved note is in that project's `.safebump/migrations/`.
2. Check it against the official migration guide.
3. Add a `source:` URL in its front matter, and copy it into `references/migrations/`.

Every project doing that upgrade then gets it without researching.

## Validating

The skill must follow the [Agent Skills spec](https://agentskills.io/specification). CI checks this with the reference validator:

```bash
uvx --from "git+https://github.com/agentskills/agentskills#subdirectory=skills-ref" skills-ref validate skills/safebump
```

## Releasing

Bump `metadata.version` in `SKILL.md` with every change you want to ship, then rebuild (the bundle's header carries the version). Also bump `version` in `.claude-plugin/plugin.json`: Claude Code plugin users only get updates when it changes.
