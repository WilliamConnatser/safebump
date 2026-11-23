import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { quote, run, sh, which } from "./exec.ts";
import type { Task } from "./tasks.ts";
import { repoUrl } from "./tasks.ts";

/** Credentials an agent running with permissions bypassed must not see. */
const SECRET_ENV = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITLAB_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_CREDENTIAL_HELPER",
];

/**
 * One environment for setup, agent and scoring:
 * - yarn/pnpm shims via corepack in <work>/bin (nothing installed globally)
 * - a private git config (no credential helpers, no global hooks) and an
 *   empty gh config dir, so nothing in the run can push or call the forge
 * - forge/npm tokens and the SSH agent removed
 */
export const makeEnv = async (workRoot: string) => {
  const bin = path.join(workRoot, "bin");
  const ghDir = path.join(workRoot, "gh-config");
  const gitConfig = path.join(workRoot, "gitconfig");
  mkdirSync(bin, { recursive: true });
  mkdirSync(ghDir, { recursive: true });
  writeFileSync(
    gitConfig,
    [
      "[user]",
      "  name = safebump-evals",
      "  email = evals@safebump.invalid",
      "[init]",
      "  defaultBranch = main",
      "[advice]",
      "  detachedHead = false",
      "[credential]",
      "  helper =",
      "",
    ].join("\n"),
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of SECRET_ENV) delete env[k];
  Object.assign(env, {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "false",
    GH_CONFIG_DIR: ghDir,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_STRICT: "0",
    // older corepack releases fail on npm's rotated signing keys
    COREPACK_INTEGRITY_KEYS: "0",
    // without a packageManager field, use corepack's known-good release, not
    // whatever is newest (which this corepack may not be able to run)
    COREPACK_DEFAULT_TO_LATEST: "0",
    COREPACK_HOME: path.join(workRoot, "corepack"),
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_update_notifier: "false",
  });
  // yarn and pnpm, if they are not already installed
  const missing = [];
  for (const pm of ["yarn", "pnpm"]) if (!(await which(pm))) missing.push(pm);
  if (missing.length > 0 && (await which("corepack"))) {
    await run("corepack", ["enable", "--install-directory", bin, ...missing], {
      cwd: workRoot,
      env,
    });
  }
  return env;
};

export type Prepared = {
  projectDir: string;
  pkgManager: string;
  nodeWarning?: string;
  installCommand: string;
};

const detectPm = (dir: string, declared?: string) => {
  if (declared) return declared;
  const pj = path.join(dir, "package.json");
  const field = existsSync(pj)
    ? (JSON.parse(readFileSync(pj, "utf8")) as { packageManager?: string })
        .packageManager
    : undefined;
  if (field) return field.split("@")[0]!;
  if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(dir, "bun.lock")) || existsSync(path.join(dir, "bun.lockb")))
    return "bun";
  return "npm";
};

/** Fallbacks in order; old repos often need a looser install. */
const installCommands = (pm: string, dir: string): string[] => {
  switch (pm) {
    case "npm":
      return [
        existsSync(path.join(dir, "package-lock.json")) ? "npm ci" : "npm install",
        "npm install",
        "npm install --legacy-peer-deps",
        "npm install --legacy-peer-deps --ignore-scripts",
      ];
    case "yarn":
      return ["yarn install", "yarn install --ignore-scripts"];
    case "pnpm":
      return ["pnpm install", "pnpm install --ignore-scripts"];
    case "bun":
      return ["bun install", "bun install --ignore-scripts"];
    default:
      throw new Error(`unknown package manager ${pm}`);
  }
};

const nodeMajor = (v: string) => Number(/(\d+)/.exec(v)?.[1]);

export const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv, log?: string) =>
  run("git", args, { cwd, env, log, timeoutMs: 10 * 60_000 });

const must = async (p: ReturnType<typeof run>, what: string) => {
  const r = await p;
  if (r.code !== 0) {
    throw new Error(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-800)}`);
  }
  return r;
};

/**
 * Gets the task's project into <taskDir>/repo, installs dependencies and
 * returns where the project root is. The repo has no remote afterwards.
 */
export const prepare = async (
  task: Task,
  taskDir: string,
  env: NodeJS.ProcessEnv,
  opts: { log: string; taskNode: boolean },
): Promise<Prepared> => {
  const repo = path.join(taskDir, "repo");
  mkdirSync(repo, { recursive: true });
  const g = (args: string[]) => git(repo, args, env, opts.log);

  if (task.path) {
    cpSync(task.path, repo, {
      recursive: true,
      filter: (src) => !/[/\\](node_modules|\.safebump|\.git)$/.test(src),
    });
    await must(g(["init", "-q"]), "git init");
  } else {
    await must(g(["init", "-q"]), "git init");
    await must(g(["remote", "add", "origin", repoUrl(task)]), "git remote add");
    await must(
      g(["fetch", "-q", "--depth", "1", "origin", task.commit!]),
      `fetching ${repoUrl(task)}@${task.commit}`,
    );
    await must(g(["checkout", "-q", "--detach", "FETCH_HEAD"]), "git checkout");
    await must(g(["remote", "remove", "origin"]), "git remote remove");
  }
  // keep install output and skill state out of every diff
  writeFileSync(
    path.join(repo, ".git", "info", "exclude"),
    "node_modules/\n.safebump/\n",
  );
  if (task.path) {
    await must(g(["add", "-A"]), "git add");
    await must(g(["commit", "-q", "--no-verify", "-m", "task source"]), "git commit");
  }

  const projectDir = task.subdir ? path.join(repo, task.subdir) : repo;
  const pkgManager = detectPm(projectDir, task.pkgManager);

  let nodeWarning: string | undefined;
  const current = nodeMajor(process.version);
  const wanted = task.nodeVersion ? nodeMajor(task.nodeVersion) : undefined;
  const nvmSh = path.join(process.env.NVM_DIR ?? path.join(homedir(), ".nvm"), "nvm.sh");
  let wrap = (cmd: string) => cmd;
  if (wanted && wanted !== current) {
    if (opts.taskNode && existsSync(nvmSh)) {
      nodeWarning = `task wants Node ${task.nodeVersion}; installed deps with it via nvm, everything else runs on ${process.version}`;
      wrap = (cmd) =>
        `. ${quote(nvmSh)} >/dev/null && nvm install ${quote(task.nodeVersion!)} >/dev/null && nvm exec --silent ${quote(task.nodeVersion!)} ${cmd}`;
    } else {
      nodeWarning = `task wants Node ${task.nodeVersion}, running on ${process.version}`;
    }
  }

  let installCommand = "";
  let lastErr = "";
  for (const cmd of installCommands(pkgManager, projectDir)) {
    const r = await sh(wrap(cmd), { cwd: projectDir, env, log: opts.log, timeoutMs: 20 * 60_000 });
    if (r.code === 0) {
      installCommand = cmd;
      break;
    }
    lastErr = (r.stderr || r.stdout).trim().slice(-800);
    // a failed install can leave a half-written tree; start the next try clean
    await g(["checkout", "-q", "--", "."]);
  }
  if (!installCommand) throw new Error(`install failed with ${pkgManager}: ${lastErr}`);
  return { projectDir, pkgManager, nodeWarning, installCommand };
};

/**
 * Commits whatever setup changed (e.g. a lockfile rewritten by install) so
 * the diff and audit afterwards cover only the agent's work.
 */
export const snapshot = async (repo: string, env: NodeJS.ProcessEnv, log: string) => {
  await git(repo, ["add", "-A"], env, log);
  await git(
    repo,
    ["commit", "-q", "--no-verify", "--allow-empty", "-m", "eval baseline"],
    env,
    log,
  );
  const r = await git(repo, ["rev-parse", "HEAD"], env);
  return r.stdout.trim();
};
