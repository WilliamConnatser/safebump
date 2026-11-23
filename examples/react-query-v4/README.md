# Example: react-query v4 → v5

A tiny app on `@tanstack/react-query` v4. Upgrading it to v5 breaks it in the ways real migrations do:

- `@tanstack/react-query-devtools` must move with it. v4 devtools peers on react-query `^4.36.1`. `safebump plan` catches this. Upgrading react-query alone would leave a peer conflict.
- `useQuery` now takes a single options object.
- `cacheTime` was renamed to `gcTime`.
- `useIsFetching` now takes a filters object.
- `isLoading` still exists but changed meaning. The type checker can't catch this one.

## Try it

[Install the skill](../../README.md#-install) for your agent, then:

```bash
cd examples/react-query-v4
npm install
```

Ask your agent to "upgrade @tanstack/react-query to v5". For example:

```bash
claude "upgrade @tanstack/react-query to v5"
```

```bash
codex "upgrade @tanstack/react-query to v5"
```

```bash
gemini -i "upgrade @tanstack/react-query to v5"
```

Run `git checkout -- . && npm install` to reset and try again.

## Adopting safebump in a project

### For everyone working in the repo

Commit the skill into the repo so every agent that opens it finds it, with no per-person setup:

```bash
npx skills add WilliamConnatser/safebump
```

This installs it at project scope for the agents you pick. Codex, Gemini CLI, Cursor, Copilot and others read `.agents/skills/`. Claude Code reads `.claude/skills/`.

### In CI, on every Renovate (or Dependabot) PR

The pipeline has two parts. [`.github/workflows/safebump.yml`](.github/workflows/safebump.yml) is the GitHub version and [`.gitlab-ci.yml`](.gitlab-ci.yml) the GitLab one; copy one into your repo, along with [`renovate.json`](renovate.json).

**1. Assurance, on every dependency PR.** It runs `safebump ci` and uses no agent and no LLM. It answers four questions:
- **Is the upgrade set complete?** Peers and packages released together, like Expo's SDK packages or react-query with its devtools.
- **Did anything break compared with the base branch?** Types, tests, lint, build.
- **Was anything papered over?** Casts, suppressions, weakened tests.
- **Do the call sites the upgrade is most likely to break run under passing tests?** This uses your test runner's real coverage.

It posts a sticky PR comment and two statuses:

| Status | Red when | Use it as |
|---|---|---|
| `safebump` | the upgrade is broken | a **required** status in branch protection |
| `safebump/automerge` | the update isn't proven low-risk | **not** required: it only vetoes Renovate's auto-merge |

**2. Fix, only when it's needed and an agent is configured.**
1. In a checkout of the base branch, the agent writes characterization tests for the untested risk sites, and proves them on the *old* version.
2. It carries those tests over to the PR branch, completes the upgrade set and fixes the breakage.
3. The assurance runs again on the result before anything is pushed.

Changes made by the agent always need a human review.

**The Renovate config** comes from `safebump renovate-config`; regenerate it for your repo with:
```bash
node .agents/skills/safebump/scripts/safebump.mjs renovate-config > renovate.json
```
- **Grouping:** packages released together become one PR, so the upgrade set is complete.
- **Settling time:** new releases wait three days before a PR opens.
- **Auto-merge:** patch and minor updates auto-merge, and only when every status is green. With `platformAutomerge: false`, Renovate checks the statuses itself, so `safebump/automerge` decides. Majors always wait for a human.

**Who owns the branch:** once the fix job pushes, Renovate stops rebasing that branch, which is what keeps the fixes from being overwritten. To get a newer version, ask Renovate to recreate the PR from its dashboard.

For a monorepo, run the job per package with `defaults.run.working-directory`.
