# safebump

**Major dependency upgrades your coding agent can prove are safe.**

<p>
    <a href="./LICENSE">
        <img src="https://img.shields.io/badge/License-MIT-FCAE00.svg?style=for-the-badge">
    </a>
</p>

Major upgrades fail in predictable ways:
- **They break the build.** That part is easy to see.
- **They need other packages to move too:** peers, plugins, a whole SDK.
- **They quietly change behavior that still compiles:** a new default, or a flag that kept its name but changed meaning.

safebump is an agent skill for **TypeScript / TSX** projects that handles all three. It plans every package that has to move together and uses the framework's own migration tool when there is one. It fixes the breakage in dependency order, then proves the result:
- no new failing tests, lint or build errors against a baseline taken before the upgrade
- no casts or suppressions papering over errors
- every changed default either pinned to the old value or deliberately accepted

It follows the open [Agent Skills](https://agentskills.io) format, so it runs in any agent that loads `SKILL.md` skills: Claude Code, Codex, Gemini CLI, Cursor, GitHub Copilot, OpenCode and others. It works on the subscription you already have; no separate LLM API key is needed.

## 🚀 Install

With the cross-agent [skills CLI](https://github.com/vercel-labs/skills), which asks which agents to install into:

```bash
npx skills add WilliamConnatser/safebump
```

Add `-g` to install for your user instead of the current project.

Or by hand: clone the repo and link `skills/safebump` into your agent's skills directory.

| Agent | Directory |
|---|---|
| Codex, Gemini CLI, Cursor, Copilot and others | `.agents/skills/` (project) or `~/.agents/skills/` (user) |
| Claude Code | `.claude/skills/` or `~/.claude/skills/`. This repo is also a Claude Code plugin marketplace: `/plugin marketplace add WilliamConnatser/safebump` |

```bash
git clone https://github.com/WilliamConnatser/safebump.git
ln -s "$PWD/safebump/skills/safebump" ~/.agents/skills/safebump
```

Then ask:

> upgrade @tanstack/react-query to v5

Or ask _"what major upgrades are available?"_, or on a dependency-update PR's branch, _"fix this upgrade"_.

The skill is self-contained: one minified script bundle, nothing to install and no dependencies added to your project. It needs Node 20+ and git.

**On every Renovate or Dependabot PR**, `safebump ci` gives the upgrade a verdict. It checks that the upgrade set is complete, that nothing broke relative to the base branch, that nothing was papered over, and that the risky changes are proven: by tests, and by a diff of the dependency's own source for the APIs you use. It posts **blocked**, **low**, **medium** or **high** as a PR comment, plus two statuses. One is required and blocks broken upgrades; the other lets Renovate auto-merge only proven low-risk updates.

That deterministic mode has no AI and no LLM cost. **AI mode is opt-in:** a sandboxed reviewer grades medium- and high-risk updates against your actual API usage and the release notes, and a coding agent fixes broken upgrades. It works with Anthropic, Bedrock, Vertex AI, Foundry, OpenAI, Azure OpenAI, Google AI, or any OpenAI-compatible endpoint.

`safebump init` sets it all up: `safebump.yml`, the GitHub Actions or GitLab CI pipeline, and `renovate.json`. See [examples/react-query-v4](examples/react-query-v4).

## ⚙️ How it works

The agent does the reading, reasoning and editing. The [CLI](cli/src) (shipped as one bundled script) does the deterministic analysis an agent can't cheaply do by hand. There are commands for each stage of an upgrade.

**Choose what to upgrade**
- `fleet` splits every pending upgrade into sequenced branches, safest first. For example, react-query 5, then react 19 on top of it.
- `impact <pkg>` estimates the blast radius before anything is installed: files touched, removed APIs in use, behavior changes and a risk level.

**Preflight**
- `doctor` checks that the install matches the manifests and lockfile, the type checker resolves, Node meets every target's `engines`, and there are no duplicate copies. Errors from a broken setup look like upgrade breakage, so this runs first.

**Plan**
- `plan <pkg>` builds the full **upgrade set**:
  - peers the new versions require
  - installed packages whose peer ranges would break
  - siblings released in lockstep (`@angular/*`)
  - matching `@types`
  - conflicts that have no solution
- `api-diff <pkg>` shows what changed **in the APIs this project uses**, including changed `@default` values and deprecations. This is how changes that compile but behave differently get caught.
- `notes <pkg>` returns cached migration notes.
- `upstream <pkg>` shows how the package's maintainers changed their own examples, docs and tests between the two versions, which is real before/after code.
- `plan` lists official migration tools (`expo install --fix`, `ng update`, Tamagui's `migrate`…) from a vetted registry, plus any discovered codemods.

**Prepare on the old version**
- `test-gaps <pkg>` lists the code that uses the package but that no test reaches. The agent writes characterization tests there first; they must pass before and after the upgrade.
- `deprecations <pkg>`: on the latest release of the current major, uses of `@deprecated` APIs get fixed first. The major bump then breaks far less.

**Fix**
- `errors <pkg>...` maps type errors to code blocks. It orders them by dependency, groups files into waves that subagents can fix in parallel, and flags repeated errors.
- `codemod` applies one mechanical change across a large codebase, with a dry run first.
- `refs` follows a changed signature to its callers.
- `checkpoint` snapshots each round with its error count and audit findings. When a round regresses, stalls or hides errors, the agent restores the best snapshot instead of leaving a half-migrated tree.

**Check**
- `verify` re-runs the type check, tests, lint and build, and reports only **new** failures compared with a baseline taken before the upgrade.
- `defaults <pkg>` lists the call sites that silently pick up a changed default, with the old value to pin.
- `duplicates <pkg>` catches packages installed in two versions after the upgrade.
- `audit` fails on added casts, `@ts-ignore`, lint suppressions, weakened tests or a loosened tsconfig.

**Ship**
- `report` writes a PR description: a version table, checks, and sections for the agent to fill in.
- `.safebump/progress.md` lets a long migration resume in a later session, or in a different agent.

**Detected, not assumed**
- **Type checker:** the project's `typecheck` script, otherwise [ts-rust](https://github.com/pingdotgg/ts-rust) (`tsc-rs`), tsgo, `vue-tsc` or `tsc`.
- **Package manager:** npm, pnpm, yarn or Bun.
- **Monorepo setup:** workspaces and TypeScript project references.

[SKILL.md](skills/safebump/SKILL.md) runs the process: plan → baseline → research (subagents with [research-migration.md](skills/safebump/references/research-migration.md)) → upgrade or the official migration tool → fix in waves (subagents with [fix-errors.md](skills/safebump/references/fix-errors.md)) → verify and audit → report. Large migrations go one major at a time.

The ordering idea comes from **[CodePlan](https://huggingface.co/papers/2309.12499)**: fix a change at its source first, then follow it to the code that depends on it. The AST work uses **[ts-morph](https://github.com/dsherret/ts-morph)**.

## 📊 Evals

[`evals/`](evals) measures the skill end to end, on any agent:
- It runs [swe-bump-bench](https://github.com/xeol-io/swe-bump-bench) (62 real upgrade tasks) or local tasks.
- It scores each run deterministically: is the target version installed, does it type-check clean, does `verify` report no new failures, and is `audit` clean.
- `compare` shows score changes between runs, including against the original CLI's 45%.

Start with a single task. A full run costs real tokens. See the [evals README](evals/README.md).

## Limitations

- It only supports TypeScript and TSX. The type checker must print tsc-style diagnostics, which tsc, tsgo, ts-rust and vue-tsc all do.
- `plan` resolves the peer ranges declared on the registry. Constraints that live only in docs are left to the agent's migration research, which reads the guide. An example is "upgrade the CLI with the framework".
- Very large framework migrations, such as Vue 2 → 3, are still arduous. Expect to steer, and commit between majors.

## 📜 Credits and license

safebump is derived from [bumpgen](https://github.com/xeol-io/bumpgen) by [Xeol](https://github.com/xeol-io), released under the MIT license. bumpgen was a CLI and GitHub Action that called the OpenAI API directly, one code block at a time. It scored 45% on [swe-bump-bench](https://github.com/xeol-io/swe-bump-bench) with GPT-4 Turbo.

What safebump keeps from it:
- the idea of fixing breakage in dependency order, from [CodePlan](https://huggingface.co/papers/2309.12499)
- the ts-morph analysis of code blocks and imports
- the type-checker output parsing

Everything else is new: running as an agent skill, upgrade-set planning, migration tools, API and default diffs, verification against a baseline, audits, checkpoints, fleet mode and the eval harness.

safebump is MIT-licensed. The [LICENSE](LICENSE) keeps Xeol's original copyright notice alongside the new one, as the MIT license requires for derived work.
