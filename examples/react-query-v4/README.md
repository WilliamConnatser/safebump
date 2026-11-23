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

### In CI, on dependency PRs

[`.github/workflows/safebump.yml`](.github/workflows/safebump.yml) runs on any PR that changes `package.json` or a lockfile and fails the type check. It doesn't matter who opened the PR: Dependabot, Renovate or a person. It runs your agent with the skill, pushes the fixes to the PR branch, and comments with the agent's report.

- **Agent:** pick it with the `SAFEBUMP_AGENT` repository variable: `claude`, `codex`, `gemini`, or `custom` with your own command. Each runs on that agent's subscription token or API key. The file header lists the secrets each one needs.
- **Security:** the agent step never sees git credentials. Release notes and package docs are untrusted input, so only the separate commit step can push.
- **Update bot:** any bot that opens PRs works. Minimal configs:

  `.github/dependabot.yml`:
  ```yaml
  version: 2
  updates:
    - package-ecosystem: "npm"
      directory: "/"
      schedule:
        interval: "weekly"
  ```

  `renovate.json`:
  ```json
  { "extends": ["config:recommended"] }
  ```

  Renovate stops rebasing a branch once someone else has committed to it. That's what you want here: safebump's fixes won't be overwritten.

For a monorepo, run the job per package with `defaults.run.working-directory`.
