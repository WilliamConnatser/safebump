import { readPackageJson } from "./packages";
import { repoKey } from "./fleet";
import { findWorkspaceRoot, listWorkspaces } from "./workspaces";
import path from "path";

// A Renovate config that cooperates with safebump:
//   - packages released together (same source repo, else npm scope) are one
//     group, so each PR is an upgrade set `plan` considers complete
//   - safebump's `safebump/automerge` status gates automerge: Renovate (not
//     the platform) merges only when every status is green, and safebump
//     marks that status green only for low-risk updates
//   - majors never automerge; new releases settle before PRs open

export const renovateConfig = (projectRoot: string) => {
  const root = findWorkspaceRoot(projectRoot) ?? projectRoot;
  const dirs = findWorkspaceRoot(projectRoot) ? listWorkspaces(root).map((w) => w.dir) : [projectRoot];

  // the repo's own workspace packages aren't Renovate's to update
  const local = new Set(listWorkspaces(root).map((w) => w.name).filter(Boolean));
  const families = new Map<string, Set<string>>();
  for (const dir of dirs) {
    const pkg = readPackageJson(dir) as
      | { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      | undefined;
    for (const name of Object.keys({ ...pkg?.devDependencies, ...pkg?.dependencies })) {
      if (name.startsWith("@types/") || local.has(name)) continue;
      const installed = readPackageJson(path.join(dir, "node_modules", name)) ?? readPackageJson(path.join(root, "node_modules", name));
      const repo = repoKey((installed as { repository?: string | { url?: string } } | undefined)?.repository);
      const key = repo ?? (name.startsWith("@") ? name.split("/")[0]! : undefined);
      if (!key) continue;
      families.set(key, (families.get(key) ?? new Set()).add(name));
    }
  }

  // a scope fallback ("@tamagui") and the repo or package named after it
  // ("tamagui/tamagui", "tamagui") are the same family
  for (const key of Array.from(families.keys()).filter((k) => k.startsWith("@"))) {
    const base = key.slice(1);
    const into = Array.from(families.keys()).find(
      (k) => k !== key && (k.split("/").pop() === base || families.get(k)!.has(base)),
    );
    if (!into) continue;
    for (const n of families.get(key)!) families.get(into)!.add(n);
    families.delete(key);
  }

  const groups = Array.from(families.entries())
    .filter(([, names]) => names.size > 1)
    .map(([key, names]) => {
      const list = Array.from(names).sort();
      const label = key.startsWith("github.com/") ? key.split("/").pop()! : key;
      return {
        groupName: label,
        matchPackageNames: list,
      };
    })
    .sort((a, b) => a.groupName.localeCompare(b.groupName));

  return {
    $schema: "https://docs.renovatebot.com/renovate-schema.json",
    extends: ["config:recommended"],
    labels: ["dependencies", "safebump"],
    // let new releases settle (and get yanked if broken) before PRs open
    minimumReleaseAge: "3 days",
    // Renovate merges itself, after checking every status, so the
    // non-required `safebump/automerge` status can veto low-confidence merges
    platformAutomerge: false,
    automergeType: "pr",
    packageRules: [
      { matchUpdateTypes: ["patch", "minor", "pin", "digest"], automerge: true },
      { matchUpdateTypes: ["major"], automerge: false, addLabels: ["major"] },
      ...groups,
    ],
  };
};
