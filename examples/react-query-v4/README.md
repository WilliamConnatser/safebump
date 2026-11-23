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

Run `safebump init` in your repo. It asks a few questions, then writes three files:
- [`safebump.yml`](safebump.yml), the only configuration
- the pipeline for your platform: [GitHub Actions](.github/workflows/safebump.yml) or [GitLab CI](.gitlab-ci.yml)
- a [`renovate.json`](renovate.json)

It then prints exactly what to set up on the CI platform. This example's files were generated that way.

```bash
node .agents/skills/safebump/scripts/safebump.mjs init
```

**Deterministic mode** is the default, and has no AI and no LLM cost. On every dependency PR, `safebump ci` answers four questions:
- **Is the upgrade set complete?** Peers and packages released together.
- **Did anything break relative to the base branch?** Types, tests, lint, build.
- **Was anything papered over?** Casts, suppressions, weakened tests.
- **Are the risky changes proven?** It checks that the call sites the upgrade is most likely to break run under passing tests. It also checks the dependency's **own source** for behavior changes in exactly the APIs you use: changed default values, changed constants (timeouts, retry counts), new errors, removed branches.

It posts a sticky comment and two statuses:

| Status | Red when | Use it as |
|---|---|---|
| `safebump` | the upgrade is broken | a **required** status in branch protection |
| `safebump/automerge` | the update isn't proven low-risk | **not** required: it only vetoes Renovate's auto-merge |

**AI mode** is opt-in: set `mode: ai` in `safebump.yml`, or answer "ai" in `init`. Two jobs are added:
- **Review**, for medium or high risk with nothing broken. A built-in, sandboxed reviewer reads the APIs you use, what changed in them (types, docs, source), whether tests run them, and the release notes for every version crossed. It grades the risk, can add characterization tests, and posts an assessment. It can raise the risk; it can never make anything auto-merge.
- **Fix**, for broken or incomplete upgrades. A coding agent writes characterization tests on the base version first, completes the upgrade set, and fixes the breakage. Then the same deterministic checks run on its result.

**Providers:** Anthropic, Amazon Bedrock, Google Vertex AI, Microsoft Foundry, OpenAI, Azure OpenAI, Google AI, or any OpenAI-compatible endpoint.
- **Cloud providers** authenticate with OIDC, so there are no stored keys.
- **On GitHub, fix mode** uses each vendor's own action: `claude-code-action`, `codex-action` or `run-gemini-cli`.
- **On GitLab**, safebump runs the agent's CLI.

```yaml
# safebump.yml: AI mode on Bedrock
version: 1
mode: ai
ci: { platform: github, failOn: blocked, coverage: true }
ai:
  provider: bedrock
  model: <your Bedrock model id>
  region: us-east-1
  review: { enabled: true, minRisk: medium, skipPatch: true }
  fix: { enabled: true, agent: claude-code }
```

After changing `safebump.yml`, regenerate the pipeline with `safebump init --write-ci`.

**The Renovate config** groups packages released together into one PR, waits three days after a release, and auto-merges patch and minor updates only when every status is green. With `platformAutomerge: false`, Renovate checks the statuses itself, so `safebump/automerge` decides. Majors always wait for a human. Once a safebump agent pushes to a PR, Renovate stops rebasing that branch, so the fixes aren't overwritten.

For a monorepo, run the job per package with `defaults.run.working-directory`.
