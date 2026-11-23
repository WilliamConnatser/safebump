---
name: safebump
description: Upgrade TypeScript/TSX dependencies to new major versions and fix the code they break, including packages that must move together. Use when the user wants to bump, upgrade or migrate npm packages, fix a dependency-update PR (Dependabot, Renovate or manual) whose build fails, upgrade all outdated dependencies, or asks which upgrades are available and how risky they are.
license: MIT
compatibility: Requires Node 20+, git, and a TypeScript project with a tsconfig.json. Network access to the npm registry; also helps for reading release notes.
metadata:
  version: "3.3.0"
---

# safebump

Upgrade dependencies and fix what breaks. Plan every package that has to move together, upgrade them, fix type errors in dependency order, then verify nothing else regressed.

The scripts do the analysis that is hard to do by hand. You do the reading, editing and judgment.

## Tools

Run `scripts/safebump <command>`, relative to this skill's directory. It's a single self-contained bundle with nothing to install. Where there's no POSIX shell, `node scripts/safebump.mjs <command>` is the same thing.
- Run it from the project root, or pass `--root <dir>`.
- Add `--json` for machine-readable output.
- Full reference: [references/commands.md](references/commands.md).

| Stage | Commands |
|---|---|
| Preflight | `doctor [pkg[@v]...]` (install matches manifests, checker resolves, Node engines, duplicates) |
| Choose | `list` (available majors) · `detect <ref>` (what a branch bumped) · `fleet` (every pending upgrade, grouped into branches) · `impact <pkg>[@v]` (blast radius before installing) |
| Plan | `plan <pkg>[@v]...` (full upgrade set: peers, dependents, lockstep siblings, `@types`, conflicts) · `notes <pkg> <from> <to>` (cached migration notes) · `api-diff <pkg> [from] [to]` (what changed in the APIs this project uses, including changed defaults and deprecations) · `api <pkg>` (new signatures) · `upstream <pkg> <from> <to>` (how the maintainers migrated their own examples and tests) |
| Prepare | `test-gaps <pkg>@<to>... [--coverage\|--confirm]` (risky call sites ranked, whether a test actually executes each, and a gate proving it before upgrading) · `deprecations <pkg>...` (uses of APIs marked `@deprecated`, usually what the next major removes) |
| Apply | `upgrade <pkg>@<v>...` (one install for the whole set) · `duplicates <pkg>...` (more than one installed copy) |
| Fix | `errors <pkg>...` (errors mapped to blocks, ordered, grouped into parallel waves, repeated errors flagged) · `refs <file> <line>` (callers of a changed declaration) · `codemod <transform.ts>` (one mechanical change across the project) · `checkpoint save/list/restore` (snapshots with error counts; roll back when stuck) · `tsc` |
| Check | `verify baseline` / `verify` (type check, tests, lint, build: only *new* failures) · `defaults <pkg> <from> <to>` (call sites silently getting a changed default) · `audit [ref]` (added casts, suppressions, weakened tests) |
| Ship | `report [base-ref]` (PR description skeleton) |

**Type checker and package manager:** both are detected, not assumed.
- **Checker:** the project's `typecheck`-style script if there is one. Otherwise ts-rust (`tsc-rs`), tsgo, `vue-tsc` or `tsc`, in that order. If detection is wrong, pass `--checker "<cmd>"` or set `SAFEBUMP_TYPECHECK`. The command must print tsc-style diagnostics.
- **Package manager:** npm, pnpm, yarn or Bun, from the `packageManager` field or the lockfile.

**Monorepos:** see [references/monorepo.md](references/monorepo.md).

**Upgrading everything:** see [references/fleet.md](references/fleet.md).

## Workflow

### 0. Resume or start

If `.safebump/progress.md` exists, read it and continue from its "Next step"; it was written by an earlier session.

For any migration bigger than one quick hop, create it from [assets/progress-template.md](assets/progress-template.md) and update it after every step below. It's how a later session, or another agent, picks up the work.

### 1. Choose the upgrade

- **The user named a package:** use it. Without a version, `plan` resolves the latest.
- **On an already-bumped branch** (a bot's PR or a manual edit): run `detect <base-ref>`. Still run `plan` on what it finds, because bots often bump only part of a set.
- **"What should I upgrade?":** run `list`, or `fleet` for everything. `impact <pkg>` shows the blast radius of a candidate without installing anything. Let the user pick.

### 2. Preflight and baseline

1. Run `doctor <pkg>[@version]...` with the targets.
   - Every ✖ must be fixed before anything else, e.g. a stale install (`npm ci`), a missing type checker, or a Node version below the targets' `engines`.
   - Environment problems aren't yours to paper over. Tell the user, or report them when unattended.
2. Check `git status` for uncommitted source changes; ignore `node_modules` and lockfiles. If there are any, ask before continuing, so the upgrade diff stays reviewable.
3. Run `verify baseline`. This records today's type errors and failing tests, lint and build. Later, `verify` reports only what *you* broke.
   - On an already-bumped branch, record the baseline on the base ref first, in a scratch worktree with its install. Skip it if that's impractical, and say so in the report.
4. Run `checkpoint save baseline`.

### 3. Plan and research

1. **Plan.** Run `plan <pkg>[@version]` and read every line.
   - **Upgrade set:** each package is listed with the reason it has to move. If the set is much bigger than the user expects, show it to them before going on.
   - **Conflicts:** don't upgrade into one. Try another target version, replace or remove the blocking package, or ask. Never use `--force` / `--legacy-peer-deps` without the user agreeing.
   - **Notes:** engine mismatches, deprecations, `@types` packages to remove, and jumps of more than one major.
   - **Official migration tools:** listed when the set includes a framework with its own upgrade command, from a vetted registry (Expo, Tamagui, Angular, Nx, Next.js, Storybook, react-query…), or discovered as a migration CLI or codemod package.
     - Prefer the tool over hand edits.
     - When it says it *replaces* `safebump upgrade` (e.g. `expo install --fix`), let it set those versions.
     - Run it from the workspace that uses the package.
2. **Migration notes.** For each package in the set with breaking changes, run `notes <pkg> <from> <to>`.
   - If notes exist, use them, and only research what they don't cover.
   - If they don't, research with [references/research-migration.md](references/research-migration.md). Give it two inputs, and use a subagent per package if you can:
     - the `api-diff <pkg> <from> <to>` output: the precise list of changes to the APIs this project uses
     - the `upstream <pkg> <from> <to>` output: the maintainers' own before/after code
   - Save the result with `notes save <pkg> <from> <to> <file>`.

   The research answers three questions that change the plan:
   - **Is there an official migration tool `plan` didn't list?** If so, use it the same way. Also add it to `assets/migration-tools.json` in the report's suggestions, with its source URL.
   - **Must the migration go one major at a time?** If so, repeat steps 3–5 per major version, committing (or checkpointing in progress.md) between hops.
   - **What can't the type checker see?** You'll need this in step 5. `api-diff`'s "may behave differently" section is the starting list.
3. **Prepare on the old version.** Making the jump smaller and safer *before* it happens beats repairing it after.
   1. **Characterization tests for the risky call sites.**
      1. Run `test-gaps <pkg>@<to>... --coverage`. It ranks the call sites the upgrade is most likely to break: removed or changed APIs, changed defaults the code relies on, and, with `--deprecations`, deprecated APIs. It reports whether a test actually *executes* each one, using the project's own runner (Vitest, Jest, `node --test`) with coverage. Files whose tests mock the package count as untested.
      2. Write tests for every risk site that isn't executed, following [references/characterization-tests.md](references/characterization-tests.md). The key rule: assert on what the code returns and sends to the dependency, and mock *beneath* the package (the network, native modules), never the package itself. With subagents, give each one a group of files.
      3. Run `test-gaps <pkg>@<to>... --confirm`. It must pass before you apply the upgrade:
         - every risk site is executed by a test
         - the tests pass on the current version
         - it saves a checkpoint and records the result in `.safebump/coverage-confirmed.json`
      - **If coverage can't be collected** (e.g. Vitest without `@vitest/coverage-v8`), the report falls back to static reachability and names the missing package. Ask before adding it. Unattended, continue on static reachability and say so in the report.
      - **Unreachable sites:** some sites are impractical to test (e.g. code that only runs on a device). List them in the report rather than writing a test that mocks the package.
   2. **Deprecations first.** If the upgrade crosses a major and a newer release of the *current* major exists:
      1. Move to it first: `plan <pkg>@<current-major>`, then upgrade.
      2. Run `deprecations <pkg>...`, and fix every use with the replacement its message names.
      3. `verify`, then `checkpoint save deprecations`.

      Those deprecations are usually exactly what the next major removes.
4. **Apply.** Run the official tool's steps, and/or the `upgrade …` command `plan` printed for the remaining packages.
   - On an already-bumped branch, upgrade only what's still missing from the set.
   - If the install reports peer problems, re-run `plan` and resolve them first.
   - Then run `duplicates <pkg>...` for the set. More than one installed copy of a package (e.g. two `@tamagui/core`) breaks at runtime: dedupe (`npm dedupe`, aligned versions, overrides) before fixing code.
   - Then `checkpoint save upgraded`.

### 4. Fix loop

Each round:

1. Run `errors <pkg>...` with every package in the set. When it reports no errors beyond the baseline, go to step 5.
2. **Repeated errors** (the same error at five or more sites) are listed first. Handle each with one codemod instead of many hand edits:
   1. Copy [assets/codemod-template.ts](assets/codemod-template.ts) to `.safebump/codemods/`.
   2. Run `codemod <file> --dry-run`, and check the diffs on two or three sites.
   3. Apply it, then run the project's formatter.
3. **Fix the remaining blocks** wave by wave, following [references/fix-errors.md](references/fix-errors.md).
   - **Few files, or no subagents:** fix them yourself, in the order listed.
   - **Many files:** for each wave, give one subagent per group of 1–5 related files the fix-errors prompt. Fill it in with their `errors` output, the migration notes and the relevant `api` / `api-diff` output. Run a wave's subagents in parallel, and wait for the whole wave before starting the next.
4. When a fix changes an exported declaration's signature or behavior, run `refs <file> <line>` and check the callers, including callers that still compile.
5. **Checkpoint the round:** `checkpoint save "round N"`, which records the error count and audit findings. Then run `checkpoint list`. If it says **regressed**, **stalled** or **AUDIT**:
   1. `checkpoint restore best`. Your current state is saved first, so nothing is lost.
   2. Change approach: a codemod, more research, `upstream` examples, or asking. Don't repeat what failed.
   3. If a second approach also stalls, stop and report what's blocking, with the best checkpoint restored.

The first phase covers blocks that use the upgraded packages. Knock-on errors come after, and many disappear on their own. After about 10 rounds, stop and report.

### 5. Verify

A clean type check is necessary but not sufficient. The worst changes are names that **still exist but changed meaning**. For example, react-query v5 kept `isLoading` but changed what it means. These compile cleanly.

1. Run `verify`. It must report no new failures in the type check, tests, lint or build. Fix any regressions the upgrade caused.
2. Run `defaults <pkg> <from> <to>` for each package in the set. Every listed call site omits an option whose default changed, so it silently gets the new behavior.
   - Preserve the old behavior by setting the old value explicitly, unless the migration notes or the user say the new default is wanted.
   - For defaults that depend on context (a model, the server), decide and set them explicitly.
   - Record every decision in the report.
3. Grep for every other runtime-only change in the migration notes and `api-diff`: renamed config options, removed side effects.
4. Run `audit`. Every finding must be fixed properly, or justified to the user. A cast or `@ts-ignore` is not a fix.
5. Act on `plan`'s notes: remove `@types` packages that are now redundant, and deal with deprecations.

### 6. Report

Run `report [base-ref]` and fill in its marked sections:
- **What changed and why:** each kind of change, citing the migration notes.
- **Verify manually:** a reviewer checklist of behavior changes, including each `defaults` decision and the `test-gaps` files still without tests.
- **Open questions:** anything that needs a human decision.

Commit only when asked. Use conventional commits, one per major-version hop, e.g. `fix(deps): upgrade <pkg> to <version>`.

## Unattended mode (CI)

When you are run without a human to ask, such as in a CI job, these changes apply:

- **Never stop to ask.**
  - Skip the dirty-tree check.
  - Don't upgrade packages outside the set `plan` produces.
  - Don't resolve `plan` conflicts by guessing; report them.
  - Where you would have asked, choose the conservative option and record the open question in the report.
- **Don't touch git or the forge.** Don't commit, push, or call the forge's API; the CI job owns those. Leave the fixes in the working tree.
- **`doctor`, `verify` and `audit` are mandatory.** If `doctor` fails, stop and report. If `verify` or `audit` fails and you can't fix it, say so at the top of the report.
- **Restore on stall without asking.** Use `checkpoint restore best`, and stop when a second approach also stalls.
- **Write the report** (the `report` output, filled in) as Markdown to the path you were given.

### CI fix mode (dependency-update PRs)

The CI pipeline runs you after its assurance pass (`safebump ci`) found fixable problems on a PR opened by Renovate, Dependabot or a person. Its report and a checked-out base branch are given to you. Do this, in order:

1. **Read the report.** Each finding is one of:
   - **incomplete upgrade set:** a package that must move too
   - **duplicate install:** the same package installed in two versions
   - **new failure** compared with the base branch: type, test, lint or build
   - **unexecuted risk site:** a risky call site no test runs
2. **Characterization tests, on the base version first.** For every unexecuted risk site:
   1. Write tests in the **base worktree**, following [references/characterization-tests.md](references/characterization-tests.md).
   2. Prove them there: `safebump test-gaps <pkg>@<new-version> --confirm --root <base worktree>` must pass.
   3. Copy the new test files into the PR checkout at the same paths. They're the contract the upgrade must keep.
3. **Complete the set:** `upgrade` any missing packages from the report, then check `duplicates`.
4. **Fix the code** with the fix loop (step 4 of the workflow), until `verify` reports no new failures. If a characterization test fails on the new version, that's a real behavior change: fix the code to preserve the old behavior. Never weaken the test.
5. **Pin changed defaults** the report lists, as in step 5 of the workflow.
6. **Re-run `safebump ci --base <base ref>`.** Write your report: what you fixed, which tests you added and what they pin, and anything you couldn't resolve.

The CI job, not you, commits, pushes and sets statuses. Anything the agent changed always gets a human review before merging.

## Rules for every fix

These are short; the full version is in [references/fix-errors.md](references/fix-errors.md).

- Preserve behavior. Change only what the new API requires. Keep hardcoded values, names and structure.
- Don't add type casts (`as`, `!`, `any`), `@ts-ignore` or `@ts-expect-error` to silence errors. Don't weaken tests or tsconfig. `audit` catches these.
- Don't add comments that explain the migration.
- If the correct fix is genuinely ambiguous (e.g. a removed feature with no replacement), stop and ask, or flag it in the report when unattended. Don't invent a workaround.
