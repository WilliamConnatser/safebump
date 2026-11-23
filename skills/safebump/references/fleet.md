# Fleet mode: upgrade everything safely

Use this when the user wants all outdated dependencies brought up to date, rather than one package.

## 1. Plan the fleet

Run `fleet`. It lists every pending upgrade, split into independent groups:

- **One group for all minor and patch updates.** These rarely break anything, but they still get verified.
- **One group per major upgrade**, holding everything `plan` says must move with it.
- **Groups are sequenced, not merged.** A group marked `after <branch>` was planned assuming that branch has landed, which keeps it small. For example, react 19 needs react-query 5. The react-query group goes first, and the react group comes after it, without react-query in it.
- **Order is safest first**, but a group never comes before a group it depends on.

Show the user the list and agree on which groups to do. For each candidate major, `impact <pkg>` gives the blast radius: files touched, removed APIs in use, and behavior changes.

## 2. One branch per group

For each agreed group, in order:

1. Create its branch from the base. If the group has `after`, branch from that group's branch instead.
2. Run the main workflow (SKILL.md steps 2–6) with the group's packages as targets. The `apply:` line is the upgrade command to run.
3. Commit. Then either push and open a PR with the `report` output as the description, using the forge CLI (`gh`, `glab`) if the user wants that, or leave the branch for them.
4. Record the outcome in `.safebump/progress.md`: done, blocked and why, or skipped.

If a group fails (unresolvable conflicts, or errors you can't fix), stop working on it. Record why, and move on to the next group that doesn't depend on it.

## 3. Wrap up

Summarize per group: branch, packages, status and links to PRs. Include anything blocked, with what a human needs to decide.
