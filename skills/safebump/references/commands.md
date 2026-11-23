# safebump command reference

Output of `scripts/safebump --help`:

```
Usage: safebump <command> [args] [options]

Commands:
  doctor [pkg[@version]...] Preflight: install matches manifests and lockfile, type checker resolves, tsconfig,
                            git state, Node vs engines (incl. the targets'), duplicate copies; exit 1 on failure
  list                      Major-version upgrades available (all workspaces when run at a workspace root)
  detect [git-ref]          Packages bumped in package.json relative to git-ref (default: current branch)
  plan <pkg>[@version]...   Every package that must move with these upgrades: required peers, dependents
                            whose peer ranges break, lockstep siblings, @types. Prints the upgrade command
  upgrade <pkg>@<version>...  Set versions in package.json and run the project's package manager install
  checker                   Which type-check command will be used, and why
  tsc                       Raw type errors (exit code 1 if there are any)
  errors <pkg>...           Type errors mapped to code blocks, ordered and grouped into waves for fixing
  impact <pkg>[@version]... Blast radius before installing: files and import sites touched, removed and changed
                            APIs in use, behavior changes, risk level (runs plan)
  api-diff <pkg> [from] [to]
                            What changed between versions in the APIs this project uses: removed/added members,
                            signature changes, changed @default values and deprecations. from defaults to the
                            installed version, to to latest
  deprecations <pkg>...     Uses of APIs the installed versions mark @deprecated (usually what the next major
                            removes), grouped by API with the replacement the deprecation names
  duplicates <pkg>...       Packages (and their scope family) installed in more than one version
  defaults <pkg> [from] [to]
                            Options whose default changed between versions, and the call sites that omit them
                            (so they silently get the new default), with the old value to pin
  test-gaps <pkg>[@to]...   Code using the packages that tests don't cover. With @to: the call sites the upgrade
                            is most likely to break (removed/changed APIs, changed defaults; --deprecations adds
                            deprecated uses), ranked. --coverage runs the project's tests with coverage to show
                            which sites actually execute. --confirm is the gate before upgrading: every risk site
                            executed by passing tests on the current version; saves a checkpoint; exit 1 if not
  upstream <pkg> [from] [to]
                            How the package's maintainers changed their own examples, docs and tests between the
                            versions, ranked by the names this project imports (--max-files, --max-lines)
  checkpoint save <label>   Snapshot the working tree (incl. untracked files) without touching HEAD or the index;
                            counts type errors and audit findings unless --errors N or --fast
  checkpoint list           Checkpoints with error and audit counts; exit 1 when the last rounds regressed or
                            stalled, or the latest hides errors (audit findings never count as best)
  checkpoint restore <id|best|last>
                            Make the working tree match a checkpoint (the current state is saved first)
  checkpoint clear          Delete all checkpoints
  api <pkg> [symbol...]     New-version signatures of <pkg> symbols the project imports; flags removed exports
  refs <file> <line>        Code blocks that reference the declaration containing file:line (any line in it)
  verify baseline           Record current type/test/lint/build failures before upgrading
  verify                    Run those checks again and report only failures that are new since the baseline
                            (exit code 1 if any). --timeout <s> per script (default 600)
  audit [ref]               Added casts, suppressions, weakened tests or tsconfig since ref (default HEAD);
                            exit code 1 if any
  codemod <transform.ts>    Apply one mechanical change across the project (see assets/codemod-template.ts).
                            --dry-run shows diffs; --files <regex> limits files
  fleet                     All pending upgrades split into sequenced groups (one branch each), safest first.
                            --fast skips the impact preview used for risk ordering
  workspaces [pkg...]       Workspace packages in this monorepo, or only those depending on pkg
  notes <pkg> [from] [to]   Cached migration notes (bundled with the skill or saved in .safebump/)
  notes save <pkg> <from> <to> <file>
                            Save research output as notes for later sessions
  report [base-ref]         PR description skeleton: version table, change stats, sections for you to fill

Options:
  --root <dir>        Project root containing package.json and tsconfig.json (default: cwd)
  --checker <cmd>     Type-check command to run instead of the detected one (or set SAFEBUMP_TYPECHECK).
                      Must print tsc-style diagnostics
  --json              Machine-readable output
  --max-errors N      errors: max error messages shown per block (default 5)
  --all-workspaces    plan/upgrade: include every workspace package that depends on the targets

```
## Exit codes

- `tsc`, `verify`, `audit`, `doctor`, `duplicates` and `checkpoint list` exit 1 when they find problems, so they can gate CI and the fix loop.
- Every command exits 1 on an operational error, such as a missing type checker or a failed install, with the message on stderr.

## Files safebump writes

Per project, in `.safebump/`, which ignores itself in git:
- `baseline.json`: written by `verify baseline`.
- `coverage-confirmed.json`: written by `test-gaps --confirm`: the risk sites proven executed, and the checkpoint.
- `progress.md`: the migration log you keep.
- `migrations/<pkg>/<from>-to-<to>.md`: saved by `notes save`.
- `codemods/`: your codemod transforms.

Per user, in `~/.cache/safebump/`: `packages/` holds downloaded package versions (used by `api-diff` and `impact`), and `repos/` holds partial git clones (used by `upstream`). Delete either folder to reset it.

In git: checkpoints are stored as refs under `refs/safebump/checkpoints/`. Remove them with `checkpoint clear`.
