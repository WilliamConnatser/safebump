import { execFile } from "child_process";
import { existsSync, readdirSync, rmdirSync } from "fs";
import { copyFile, mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";

import type { Checker } from "./checker";
import { getBuildErrors } from "./checker";
import { findPackageManager } from "./packages";

// Checkpoints of the whole working tree (tracked edits, untracked files,
// package.json and lockfiles; not ignored files) stored as commits under
// refs/safebump/checkpoints/<n>. Saving builds the commit through a temporary
// index, so HEAD, the branch, the real index and the files are untouched;
// restoring writes only the files that differ. A fix loop can save after
// every wave and roll back when a round makes things worse.

export type Checkpoint = {
  id: number;
  ref: string;
  sha: string;
  tree: string;
  label: string;
  errors: number | null;
  // audit findings (casts, suppressions, weakened tests) in this state; a
  // checkpoint that cheated its way to fewer errors is never "best"
  audit: number | null;
  createdAt: string;
  // saved by restoreCheckpoint, not by the agent
  auto: boolean;
};

export type CheckpointList = {
  checkpoints: Checkpoint[];
  // fewest errors, latest on a tie; only checkpoints with a known count
  best?: Checkpoint;
  // the latest checkpoint has audit findings
  cheated: boolean;
  // the newest checkpoint has more errors than the one before it
  regressed: boolean;
  // neither of the last two rounds reduced errors
  stalled: boolean;
};

export type RestoreResult = {
  restored: Checkpoint;
  // the state just before restoring, so the restore can be undone
  backup?: Checkpoint;
  written: string[];
  deleted: string[];
  // the working tree's snapshot equals the checkpoint after restoring
  exact: boolean;
  reinstall: boolean;
  installCommand?: string;
};

const PREFIX = "refs/safebump/checkpoints/";
const BACKUP_LABEL = "before restore";
const TRAILER_ERRORS = "Safebump-Errors";
const TRAILER_AUDIT = "Safebump-Audit";
const TRAILER_CREATED = "Safebump-Created";
const TRAILER_AUTO = "Safebump-Auto";
const DEPENDENCY_FILES =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|\.npmrc|\.yarnrc\.yml)$/;

type GitResult = { code: number; stdout: string; stderr: string };

const git = (args: string[], cwd: string, env: Record<string, string> = {}, input?: string) =>
  new Promise<GitResult>((resolve) => {
    const child = execFile(
      "git",
      args,
      { cwd, maxBuffer: 512 * 1024 * 1024, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stdout, stderr: err && !stderr ? err.message : stderr });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });

const must = async (args: string[], cwd: string, env?: Record<string, string>, input?: string) => {
  const r = await git(args, cwd, env, input);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout;
};

// a fixed identity: these commits are private refs, and the user may have
// no identity configured (or commit signing that would prompt)
const IDENTITY = {
  GIT_AUTHOR_NAME: "safebump",
  GIT_AUTHOR_EMAIL: "safebump@localhost",
  GIT_COMMITTER_NAME: "safebump",
  GIT_COMMITTER_EMAIL: "safebump@localhost",
};

const repoTop = async (projectRoot: string) => {
  const top = await git(["rev-parse", "--show-toplevel"], projectRoot);
  if (top.code !== 0) {
    throw new Error(`${projectRoot} is not inside a git repository; checkpoints need git. Run \`git init\` and commit first.`);
  }
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], projectRoot);
  if (head.code !== 0) {
    throw new Error("HEAD has no commit yet (unborn branch); make an initial commit before using checkpoints.");
  }
  return { top: top.stdout.trim(), head: head.stdout.trim() };
};

// the working tree as a tree object, built in a throwaway index. Starting
// from a copy of the real index keeps its stat cache, so unchanged files
// aren't re-hashed
const snapshotTree = async (top: string) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "safebump-index-"));
  const index = path.join(tmp, "index");
  const env = { GIT_INDEX_FILE: index };
  try {
    const realIndex = path.resolve(top, (await must(["rev-parse", "--git-path", "index"], top)).trim());
    if (existsSync(realIndex)) await copyFile(realIndex, index);
    else await must(["read-tree", "HEAD"], top, env);
    await must(["add", "-A", "--", ":/"], top, env);
    return (await must(["write-tree"], top, env)).trim();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
};

const parseMessage = (message: string) => {
  const trailer = (key: string) => new RegExp(`^${key}: (.*)$`, "m").exec(message)?.[1]?.trim();
  const errors = trailer(TRAILER_ERRORS);
  const audit = trailer(TRAILER_AUDIT);
  return {
    audit: audit && /^\d+$/.test(audit) ? parseInt(audit, 10) : null,
    label: message.split("\n")[0]!.replace(/^safebump checkpoint: /, ""),
    errors: errors && /^\d+$/.test(errors) ? parseInt(errors, 10) : null,
    createdAt: trailer(TRAILER_CREATED) ?? "",
    auto: trailer(TRAILER_AUTO) === "true",
  };
};

const readCheckpoints = async (top: string): Promise<Checkpoint[]> => {
  const out = await must(
    ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(tree)%00%(contents)%00%00", PREFIX],
    top,
  );
  return out
    .split("\0\0")
    .map((rec) => rec.replace(/^\n/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [ref, sha, tree, message] = rec.split("\0");
      return { id: parseInt(ref!.slice(PREFIX.length), 10), ref: ref!, sha: sha!, tree: tree!, ...parseMessage(message ?? "") };
    })
    .filter((c) => Number.isInteger(c.id))
    .sort((a, b) => a.id - b.id);
};

const save = async (
  top: string,
  head: string,
  label: string,
  errors: number | null,
  auto: boolean,
  tree?: string,
  audit: number | null = null,
): Promise<Checkpoint> => {
  tree ??= await snapshotTree(top);
  const createdAt = new Date().toISOString();
  const message = [
    `safebump checkpoint: ${label.replace(/\s*\n\s*/g, " ")}`,
    "",
    `${TRAILER_ERRORS}: ${errors ?? "unknown"}`,
    ...(audit !== null ? [`${TRAILER_AUDIT}: ${audit}`] : []),
    `${TRAILER_CREATED}: ${createdAt}`,
    ...(auto ? [`${TRAILER_AUTO}: true`] : []),
    "",
  ].join("\n");
  const sha = (await must(["commit-tree", "--no-gpg-sign", tree, "-p", head, "-F", "-"], top, IDENTITY, message)).trim();
  // an empty old value makes update-ref fail rather than overwrite a
  // checkpoint another process created meanwhile; retry with the next id
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await readCheckpoints(top);
    const id = (existing.at(-1)?.id ?? 0) + 1;
    const ref = `${PREFIX}${id}`;
    const r = await git(["update-ref", "-m", `safebump checkpoint ${id}`, ref, sha, ""], top);
    if (r.code === 0) return { id, ref, sha, tree, label, errors, audit, createdAt, auto };
  }
  throw new Error("Could not create a checkpoint ref (concurrent writers?).");
};

export const saveCheckpoint = async (
  projectRoot: string,
  label: string,
  opts: { errors?: number; checker?: Checker; audit?: number } = {},
): Promise<Checkpoint> => {
  const { top, head } = await repoTop(projectRoot);
  let errors: number | null = opts.errors ?? null;
  if (errors === null && opts.checker) {
    errors = (await getBuildErrors(projectRoot, opts.checker)).length;
  }
  return save(top, head, label, errors, false, undefined, opts.audit ?? null);
};

export const listCheckpoints = async (projectRoot: string): Promise<CheckpointList> => {
  const { top } = await repoTop(projectRoot);
  const checkpoints = await readCheckpoints(top);
  // backups taken by restore are not rounds of the fix loop
  const counted = checkpoints.filter(
    (c) => !c.auto && c.errors !== null && !(c.audit && c.audit > 0),
  ) as (Checkpoint & { errors: number })[];
  const best = counted.reduce<(typeof counted)[number] | undefined>(
    (acc, c) => (!acc || c.errors <= acc.errors ? c : acc),
    undefined,
  );
  const [a, b, c] = counted.slice(-3);
  const [prev, last] = counted.slice(-2);
  const regressed = !!prev && !!last && last.errors > prev.errors;
  const stalled = !!a && !!b && !!c && b.errors >= a.errors && c.errors >= b.errors;
  const latest = checkpoints.filter((c) => !c.auto).at(-1);
  const cheated = !!latest?.audit && latest.audit > 0;
  return { checkpoints, best, regressed, stalled, cheated };
};

const resolveTarget = (list: CheckpointList, target: string | number) => {
  const { checkpoints } = list;
  if (checkpoints.length === 0) throw new Error("No checkpoints saved yet.");
  if (target === "best") {
    if (!list.best) throw new Error("No checkpoint has an error count; restore one by id or \"last\".");
    return list.best;
  }
  if (target === "last") {
    const last = checkpoints.filter((c) => !c.auto).at(-1);
    if (!last) throw new Error("Only automatic \"before restore\" checkpoints exist; restore one by id.");
    return last;
  }
  const id = typeof target === "number" ? target : parseInt(String(target), 10);
  const found = checkpoints.find((c) => c.id === id);
  if (!found) {
    throw new Error(`No checkpoint ${target}. Available: ${checkpoints.map((c) => c.id).join(", ")}, best, last.`);
  }
  return found;
};

// paths that differ between two trees, split by what restoring must do
const treeChanges = async (top: string, from: string, to: string) => {
  const out = await must(["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to], top);
  const parts = out.split("\0").filter(Boolean);
  const write: string[] = [];
  const remove: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!;
    const file = parts[i + 1]!;
    (status === "D" ? remove : write).push(file);
  }
  return { write, remove };
};

// drops directories left empty by deletions, up to the repo root
const pruneEmptyDirs = (top: string, files: string[]) => {
  const dirs = new Set(files.map((f) => path.dirname(f)).filter((d) => d !== "."));
  const sorted = Array.from(dirs).sort((a, b) => b.split("/").length - a.split("/").length);
  for (let dir of sorted) {
    while (dir && dir !== ".") {
      const full = path.join(top, dir);
      try {
        if (readdirSync(full).length > 0) break;
        rmdirSync(full);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }
};

export const restoreCheckpoint = async (
  projectRoot: string,
  target: string | number,
): Promise<RestoreResult> => {
  const { top, head } = await repoTop(projectRoot);
  const restored = resolveTarget(await listCheckpoints(projectRoot), target);
  const current = await snapshotTree(top);
  if (current === restored.tree) {
    return { restored, written: [], deleted: [], exact: true, reinstall: false };
  }

  const backup = await save(top, head, BACKUP_LABEL, null, true, current);
  const { write, remove } = await treeChanges(top, current, restored.tree);

  // deletions first: a file may be replaced by a directory of the same name
  for (const file of remove) await rm(path.join(top, file), { force: true, recursive: true });
  pruneEmptyDirs(top, remove);
  if (write.length > 0) {
    // --worktree only: the index stays as it was
    await must(
      ["restore", `--source=${restored.sha}`, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"],
      top,
      { GIT_LITERAL_PATHSPECS: "1" },
      write.join("\0") + "\0",
    );
  }

  const exact = (await snapshotTree(top)) === restored.tree;
  const reinstall = [...write, ...remove].some((f) => DEPENDENCY_FILES.test(f));
  return {
    restored,
    backup,
    written: write,
    deleted: remove,
    exact,
    reinstall,
    installCommand: reinstall ? `${findPackageManager(projectRoot)} install` : undefined,
  };
};

export const clearCheckpoints = async (projectRoot: string) => {
  const { top } = await repoTop(projectRoot);
  const checkpoints = await readCheckpoints(top);
  if (checkpoints.length > 0) {
    await must(["update-ref", "--stdin"], top, {}, checkpoints.map((c) => `delete ${c.ref} ${c.sha}\n`).join(""));
  }
  return { deleted: checkpoints.length };
};

// --- printers ---------------------------------------------------------------

const describe = (c: Checkpoint) =>
  `#${c.id} ${c.label} (${c.errors === null ? "errors unknown" : `${c.errors} errors`}${c.audit ? `, ${c.audit} AUDIT FINDING(S), not eligible as best` : ""}, ${c.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z")})${c.auto ? " [auto]" : ""}`;

export const printCheckpoint = (c: Checkpoint) => {
  console.log(`Saved checkpoint ${describe(c)}`);
  console.log(`ref ${c.ref} → ${c.sha.slice(0, 12)}. HEAD, the index and the files are unchanged.`);
};

export const printCheckpoints = (l: CheckpointList) => {
  if (l.checkpoints.length === 0) {
    console.log("No checkpoints.");
    return;
  }
  for (const c of l.checkpoints) {
    console.log(`${c === l.best ? "*" : "-"} ${describe(c)}`);
  }
  if (l.best) console.log(`\nbest: #${l.best.id} (${l.best.errors} errors)`);
  if (l.cheated) {
    console.log("AUDIT: the latest checkpoint hides errors (casts, suppressions or weakened tests). Restore the best checkpoint and fix them properly.");
  }
  if (l.stalled) {
    console.log("STALLED: the last two rounds did not reduce errors. Restore the best checkpoint and change approach.");
  } else if (l.regressed) {
    console.log("REGRESSED: the last round increased errors. Consider `checkpoint restore best`.");
  }
};

export const printRestore = (r: RestoreResult) => {
  if (!r.backup) {
    console.log(`The working tree already matches checkpoint ${describe(r.restored)}. Nothing changed.`);
    return;
  }
  console.log(`Restored checkpoint ${describe(r.restored)}`);
  console.log(`${r.written.length} file(s) written, ${r.deleted.length} deleted. HEAD and the index are unchanged.`);
  for (const f of r.written.slice(0, 30)) console.log(`  M ${f}`);
  for (const f of r.deleted.slice(0, 30)) console.log(`  D ${f}`);
  const more = Math.max(0, r.written.length - 30) + Math.max(0, r.deleted.length - 30);
  if (more > 0) console.log(`  (+${more} more)`);
  console.log(`Previous state saved as checkpoint #${r.backup.id}; restore it to undo.`);
  if (!r.exact) console.log("WARNING: the working tree does not exactly match the checkpoint afterwards (submodules or files git can't write?).");
  if (r.reinstall) console.log(`package.json or lockfiles changed: run \`${r.installCommand}\` before type-checking.`);
};

export const printClear = (r: { deleted: number }) => {
  console.log(`Deleted ${r.deleted} checkpoint(s).`);
};
