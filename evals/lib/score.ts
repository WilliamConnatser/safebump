import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { git } from "./setup.ts";

export const installedVersion = (projectDir: string, pkg: string) => {
  const pj = path.join(projectDir, "node_modules", pkg, "package.json");
  if (!existsSync(pj)) return null;
  return (JSON.parse(readFileSync(pj, "utf8")) as { version?: string }).version ?? null;
};

const parse = (v: string) => {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
};

/**
 * Is `installed` at the task's target? swe-bump-bench targets are "^x.y.z"
 * or "x.y.z"; both count as reached by any version with the same major that
 * is >= x.y.z (agents may legitimately pick a newer patch/minor).
 */
export const atTarget = (installed: string | null, versionTo: string) => {
  if (!installed) return false;
  const want = parse(versionTo);
  const have = parse(installed);
  if (!want || !have) return false;
  if (have[0] !== want[0]) return false;
  for (let i = 1; i < 3; i++) {
    if (have[i]! !== want[i]!) return have[i]! > want[i]!;
  }
  return true;
};

const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
];
const EXCLUDE = LOCKFILES.map((f) => `:(exclude,glob)**/${f}`);

export type DiffStats = {
  files: number;
  added: number;
  removed: number;
  /** changed files other than package.json manifests */
  sourceFiles: number;
  paths: string[];
};

/** Diff from the pre-agent snapshot to the working tree, lockfiles excluded. Saves the patch. */
export const diffStats = async (
  repo: string,
  base: string,
  env: NodeJS.ProcessEnv,
  patchFile: string,
): Promise<DiffStats> => {
  // count new files too
  await git(repo, ["add", "-A", "--intent-to-add"], env);
  const numstat = await git(repo, ["diff", "--numstat", base, "--", ".", ...EXCLUDE], env);
  const patch = await git(repo, ["diff", base, "--", ".", ...EXCLUDE], env);
  writeFileSync(patchFile, patch.stdout);
  const stats: DiffStats = { files: 0, added: 0, removed: 0, sourceFiles: 0, paths: [] };
  for (const line of numstat.stdout.split("\n")) {
    const [a, r, file] = line.split("\t");
    if (!file) continue;
    stats.files++;
    stats.added += Number(a) || 0;
    stats.removed += Number(r) || 0;
    if (path.basename(file) !== "package.json") stats.sourceFiles++;
    stats.paths.push(file);
  }
  return stats;
};
