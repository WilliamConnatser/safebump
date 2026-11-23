# safebump evals

Measures what the skill actually achieves, so every change to `skills/safebump` can be judged by a number, on any agent CLI.

Each task is a real repo at a commit plus "upgrade `<package>` to `<version>`". The harness sets the project up, records a baseline, runs the agent headless with the skill, then grades the result deterministically with the skill's own CLI.

## Safety and cost (read first)

- **Agents run with permissions bypassed** (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`), in repos and on release notes you didn't write. **Run the harness in a container or VM.**
- What the harness does to limit damage:
  - Each task gets its own throwaway directory under `--work-dir` (default `$TMPDIR/safebump-evals/<run>`). The harness refuses a work dir inside this repo.
  - The clone has no `origin` remote.
  - The agent gets a private git config with no credential helpers, `GIT_SSH_COMMAND=false` and an empty `GH_CONFIG_DIR`. `GH_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN` and `SSH_AUTH_SOCK` are removed from its environment.
  - The agent still has your home directory, including its own login, and network access. That is why a container is the recommendation.
- **Cost:** a full swe-bump-bench run is 62 agent sessions. Each one researches a migration and edits a real codebase, so expect tens of dollars or a good share of a subscription's limits, and hours of wall time. Always smoke-test one task first.

## Setup

```bash
cd evals
npm install          # tsx + typescript, nothing else
```

The skill is a prebuilt bundle with nothing to install; run `npm run build` in `cli/` first if you changed its source. Node 20+, git and network access are required. yarn and pnpm don't need to be installed: the harness gives the run corepack shims (cache in the work dir).

## Run

Smoke test first. The local task copies `examples/react-query-v4` instead of cloning:

```bash
# no agent: checks setup, baseline and scoring (always "fails": nothing was upgraded)
npx tsx run.ts --agent claude --tasks tasks/local.json --dry-run

# control: bump the version with `safebump upgrade`, fix nothing
npx tsx run.ts --agent upgrade-only --tasks tasks/local.json

# the real thing, one task
npx tsx run.ts --agent claude --tasks tasks/local.json
npx tsx run.ts --agent claude --limit 1          # first swe-bump-bench task
```

Then the benchmark:

```bash
npx tsx run.ts --agent claude --concurrency 2
npx tsx run.ts --agent codex  --filter 'react-router|glob' --timeout-min 30
npx tsx run.ts --agent gemini --out results/gemini-baseline
npx tsx run.ts --agent custom --agent-cmd 'opencode run "$(cat "$SAFEBUMP_PROMPT_FILE")"'
```

| Option | |
|---|---|
| `--agent` | `claude`, `codex`, `gemini`, `custom`, or `upgrade-only` (control: `safebump upgrade`, no fixing) |
| `--agent-cmd` | For `custom` (or `SAFEBUMP_AGENT_CMD`). Runs under `bash -c` in the project dir with `SAFEBUMP_PROMPT_FILE`, `SAFEBUMP_REPORT_FILE`, `SAFEBUMP_PROJECT_DIR`, `SAFEBUMP_SKILL_DIR` set |
| `--tasks` | File or URL. Default: swe-bump-bench `tasks.json`, pinned to a commit |
| `--filter` / `--limit` | Regex on task id / first N tasks |
| `--concurrency` | Tasks in parallel (default 1). Installs and type checks are CPU- and disk-heavy |
| `--timeout-min` | Agent time limit per task (default 45). The agent's whole process group is killed |
| `--out` | Results dir (default `results/<timestamp>-<agent>`). Pointing at an existing one resumes it: tasks already scored there are skipped; `--rerun` re-runs them |
| `--work-dir` | Where repos are cloned (default `$TMPDIR/safebump-evals/<run>`) |
| `--skill` | Skill directory to evaluate (default `../skills/safebump`). Point it at a git worktree to evaluate another branch |
| `--dry-run` | Everything except invoking the agent |
| `--task-node` | Install dependencies under the task's `nodeVersion` via nvm (see below) |
| `--keep-work` | Keep each task's repo and `node_modules` for debugging. By default they are deleted after scoring |

The agent invocations mirror the "Fix" step of [examples/react-query-v4/.github/workflows/safebump.yml](../examples/react-query-v4/.github/workflows/safebump.yml), with machine-readable output turned on where the CLI has it (`claude -p --output-format json`, `codex exec --json`, `gemini -p --output-format json`), so cost and tokens can be recorded. The prompt is the workflow's too: follow `SKILL.md` in unattended mode, upgrade the package, write the report to a file. It is saved as `tasks/<id>/prompt.md`.

### Node versions

Tasks record the Node version they were collected with (mostly 20, some 16/18). By default everything runs on the current Node and the summary notes each mismatch. `--task-node` runs only the dependency install under the task's version through nvm (`~/.nvm/nvm.sh` or `$NVM_DIR`). The skill's scripts and the agent CLIs need Node 20+, so they always use the current Node. In practice, Node 20 or 22 installs nearly all tasks. Use `--task-node` for a task whose install fails on engine checks or native modules.

## What happens per task

1. **Setup:** shallow-fetch `owner/name` at `commit` (or copy `path`), remove the remote, then install with the task's package manager. On failure, retry with a looser install (`npm install`, `--legacy-peer-deps`, `--ignore-scripts`).
2. **Baseline,** before any upgrade: `safebump verify baseline` (type check, tests, lint and build failures that already exist) and `safebump tsc --json` (error count). Then the harness commits the tree as the "eval baseline" commit, so the diff and audit cover only the agent's work. The agent's own `verify baseline` writes to the same file. The harness restores its copy before grading, so an agent that re-records the baseline after upgrading gains nothing.
3. **Agent:** headless, in the project dir, with a time limit. stdout and stderr go to `agent.log`.
4. **Score,** all deterministic:

| Criterion | How |
|---|---|
| target installed | `node_modules/<package>/package.json` version has the target's major and is >= it (`^10.2.0` → any `10.x` >= `10.2.0`) |
| type check clean | `safebump tsc --json` reports 0 errors. If the baseline already had errors, the check is "no more than before" instead, and the summary counts those tasks |
| verify | `safebump verify --json` has no new failures in any check |
| audit | `safebump audit <baseline-commit> --json` has no findings (casts, `@ts-ignore`, weakened tests or tsconfig: cheating) |
| diff | `git diff --numstat` against the baseline commit, untracked files included, lockfiles excluded. Saved as `diff.patch` |

**A task passes iff target installed AND type check clean AND verify reports no new failures AND audit has no findings.** If the skill lacks `verify` or `audit` (older versions), that criterion shows `unavailable` and doesn't block a pass.

The summary also reports the **legacy swe-bump-bench grading**: target installed and `tsc` errors after <= before. This is the bar the original bumpgen's 45% (28/62) was measured on. The harness also requires the target version to be installed, which the original grading didn't, so this is at least as strict as the original. It is a much weaker bar than "pass": it ignores tests, lint, build and cheating.

## Results

`results/` is gitignored. Each run directory has:

- `summary.md`: pass rate, rate per criterion, median agent time, cost and tokens, and a row per task
- `results.jsonl`: one JSON object per task (see `TaskResult` in [lib/report.ts](lib/report.ts))
- `config.json`: the agent, the skill path, and the skill version and git rev (marked dirty if uncommitted)
- `tasks/<id>/`: `prompt.md`, `agent.log`, `harness.log` (setup and every skill CLI call), `report.md` (the agent's), `diff.patch`, `result.json`

```bash
npx tsx run.ts summarize results/<run>          # rebuild summary.md
npx tsx run.ts compare results/<A> results/<B>  # pass rates + per-task flips
npx tsx run.ts compare legacy results/<B>       # vs the original bumpgen's per-task swe-bump-bench results
```

### Reading the numbers

- Compare runs on the **same task set and agent**. Agents are nondeterministic, so a flip on one or two tasks is noise. Re-run the flipped tasks (`--filter`) before believing them.
- `ERROR` rows are harness failures (clone, install, baseline). They count against "of all tasks" but not "of tasks the harness could score". Fix or drop them rather than reading them as skill failures.
- In each row, look at `tsc before→after`, `verify`, and `audit`. A run that reaches 0 type errors with audit findings is cheating, not a fix. A `verify` failure shows which check broke (`typecheck`, `test`, `lint`, `build`).
- Some swe-bump-bench repos also fail `build` or `test` for environmental reasons. Those failures exist at baseline too, so `verify` reports only new ones.
- `upgrade-only` is the floor: it shows what each task looks like with no fixing.

## Tasks

The default source is [swe-bump-bench](https://github.com/xeol-io/swe-bump-bench) `tasks.json` (63 entries, 62 unique ids), pinned in [lib/tasks.ts](lib/tasks.ts). Each repo is TypeScript with `strict: true`, and bumping the package breaks `tsc`.

Local task files use the same format. Give each task one source:

```json
[
  {
    "id": "unique-id",
    "package": "@tanstack/react-query",
    "versionTo": "5.59.0",

    "owner": "github-owner", "name": "repo", "commit": "<full sha>",
    // or: "repo": "https://any/git/url.git", "commit": "<full sha>",
    // or: "path": "../relative/to/this/file",

    "pkgManager": "npm",          // optional; npm | yarn | pnpm | bun, else from packageManager/lockfile
    "nodeVersion": "20",          // optional; used for the mismatch warning and --task-node
    "subdir": "packages/app",     // optional; project root inside the repo
    "notes": "extra prompt text"  // optional; appended to the prompt
  }
]
```

(Comments are for illustration; the file must be plain JSON.) See [tasks/local.json](tasks/local.json). Good tasks break the type check when upgraded, and their baseline is clean. Check both with `--agent upgrade-only` before adding a task.

## Development

```bash
npm run typecheck
```
