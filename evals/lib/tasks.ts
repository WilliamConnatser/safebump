import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * swe-bump-bench (https://github.com/xeol-io/swe-bump-bench), pinned. Each
 * task is a repo at a commit where bumping `package` to `versionTo` makes
 * `tsc` fail. The pre-skill bumpgen scored 28/62 (45%) on it; that run's
 * per-task results are LEGACY_EVAL_URL.
 */
export const SWE_BUMP_BENCH_SHA = "d4504129fd9b536ad5aca2e74f35f5d51e3362e4";
export const SWE_BUMP_BENCH_URL = `https://raw.githubusercontent.com/xeol-io/swe-bump-bench/${SWE_BUMP_BENCH_SHA}/tasks.json`;
export const LEGACY_EVAL_URL = `https://raw.githubusercontent.com/xeol-io/swe-bump-bench/${SWE_BUMP_BENCH_SHA}/evals/bumpgen/v_8df9f7de936707815eb12e226517a1b0023383eb/eval.json`;

export type Task = {
  id: string;
  package: string;
  versionTo: string;
  /** npm | yarn | pnpm | bun; detected from the lockfile when absent */
  pkgManager?: string;
  nodeVersion?: string;
  /** clone source: github owner/name at commit ... */
  owner?: string;
  name?: string;
  commit?: string;
  /** ... or any git URL at commit ... */
  repo?: string;
  /** ... or a local directory (relative to the tasks file), copied */
  path?: string;
  /** subdirectory of the repo that holds package.json/tsconfig.json */
  subdir?: string;
  /** extra instructions appended to the prompt */
  notes?: string;
};

const fetchText = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  return res.text();
};

export const loadJson = async (source: string): Promise<unknown> =>
  JSON.parse(
    /^https?:\/\//.test(source)
      ? await fetchText(source)
      : readFileSync(source, "utf8"),
  );

export const resolveTaskSource = (source: string | undefined) =>
  !source || source === "swe-bump-bench" ? SWE_BUMP_BENCH_URL : source;

export const loadTasks = async (source: string): Promise<Task[]> => {
  const data = await loadJson(source);
  const list = Array.isArray(data)
    ? data
    : ((data as { tasks?: unknown[] }).tasks ?? []);
  const baseDir = /^https?:\/\//.test(source)
    ? process.cwd()
    : path.dirname(path.resolve(source));
  const seen = new Set<string>();
  const tasks: Task[] = [];
  for (const raw of list as Task[]) {
    if (!raw.id || !raw.package || !raw.versionTo) {
      throw new Error(
        `task ${JSON.stringify(raw)} needs id, package and versionTo`,
      );
    }
    if (!raw.path && !raw.repo && !(raw.owner && raw.name)) {
      throw new Error(`task ${raw.id} needs path, repo or owner+name`);
    }
    if (!raw.path && !raw.commit) {
      throw new Error(`task ${raw.id} needs a commit to clone`);
    }
    // swe-bump-bench lists one task twice
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    const task = { ...raw };
    if (task.path) task.path = path.resolve(baseDir, task.path);
    if (task.path && !existsSync(task.path)) {
      throw new Error(`task ${task.id}: path ${task.path} does not exist`);
    }
    tasks.push(task);
  }
  return tasks;
};

/** filesystem-safe directory name for a task id */
export const slug = (id: string) =>
  id.replace(/[^\w.@-]+/g, "_").replace(/^_+|_+$/g, "");

export const repoUrl = (t: Task) =>
  t.repo ?? `https://github.com/${t.owner}/${t.name}.git`;
