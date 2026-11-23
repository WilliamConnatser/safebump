# Monorepos

safebump handles npm, yarn, pnpm and Bun workspaces, and TypeScript project references.

## Find where the package is used

Run `workspaces <pkg>`. It lists the workspace packages that depend on `<pkg>`, with their version ranges. Run `workspaces` with no argument to list them all.

## Plan and upgrade across workspaces

Keep one version of a dependency across the repo unless the user wants otherwise:

- `plan <pkg>@<v> --all-workspaces` counts every workspace's dependencies when looking for peers and dependents that would break.
- `upgrade <pkg>@<v>... --all-workspaces` updates every workspace `package.json` that lists the packages, then runs one install from the workspace root.

Run both from the workspace that matters most (pass `--root <dir>`), or from the repo root.

## Type check and fix per workspace

Each workspace with its own `tsconfig.json` is checked on its own. For each workspace from `workspaces <pkg>`, run `errors <pkg> --root <workspace>`.

- **Order:** start with the libraries other workspaces depend on. If a shared library changes its exports, its dependents may break.
- **Root solution tsconfig:** the root `tsconfig.json` may just list other projects (`"files": []` plus `"references"`). In that case safebump type-checks with build mode (`tsc -b`) and analyzes every referenced project together. Build mode may write output files; projects set up this way normally gitignore them.
- **Wrong checker:** if the repo type-checks through a task runner (turbo, nx), point safebump at it with `--checker "<cmd>"`, e.g. `--checker "pnpm turbo run typecheck"`. The command must print tsc-style diagnostics.

`verify baseline` / `verify` and `audit` work from the repo root, or per workspace with `--root`.
