import { copyFileSync, existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import type { Checker } from "./checker";
import { resolveChecker } from "./checker";
import { findPackageManager } from "./packages";
import { stateDir } from "./state";
import { run } from "./subprocess";
import { recordBaseline } from "./verify";
import { findWorkspaceRoot } from "./workspaces";

// A checkout of the base branch next to the PR: where the baseline is
// recorded (failures that already exist aren't the PR's), and where fix
// mode writes characterization tests on the old version.

const INSTALL: Record<string, string> = {
  npm: "npm ci --no-audit --no-fund",
  pnpm: "corepack enable && pnpm install --frozen-lockfile",
  yarn: "corepack enable && yarn install",
  bun: "bun install --frozen-lockfile",
};

export const installCommand = (dir: string) => INSTALL[findPackageManager(dir)] ?? INSTALL.npm!;

export const runInstall = async (dir: string) => {
  const root = findWorkspaceRoot(dir) ?? dir;
  const command = installCommand(root);
  const r = await run(command, { cwd: root });
  if (r.code !== 0) throw new Error(`'${command}' failed in ${root}:\n${(r.stderr || r.stdout).slice(-2000)}`);
  return { root, command };
};

export type BaseCheckout = { dir: string; projectDir: string; baseline: string; installed: string };

export const prepareBase = async (
  projectRoot: string,
  base: string,
  options: { dir?: string; checkerOverride?: string } = {},
): Promise<BaseCheckout> => {
  const top = (await run("git rev-parse --show-toplevel", { cwd: projectRoot })).stdout.trim();
  if (!top) throw new Error("not a git repository");
  const rel = path.relative(top, projectRoot);
  const dir = options.dir ?? mkdtempSync(path.join(tmpdir(), "safebump-base-"));

  if (!existsSync(path.join(dir, ".git"))) {
    const add = await run(`git worktree add --detach "${dir}" "${base}"`, { cwd: top });
    if (add.code !== 0) throw new Error(`git worktree add ${base} failed: ${add.stderr.trim()}`);
  }
  const projectDir = path.join(dir, rel);
  const { command } = await runInstall(projectDir);

  const checker: Checker = resolveChecker(projectDir, options.checkerOverride);
  await recordBaseline(projectDir, checker);
  const from = path.join(stateDir(projectDir), "baseline.json");
  const to = path.join(stateDir(projectRoot), "baseline.json");
  copyFileSync(from, to);
  return { dir, projectDir, baseline: to, installed: command };
};

export const removeBase = async (projectRoot: string, dir: string) => {
  await run(`git worktree remove --force "${dir}"`, { cwd: projectRoot });
};
