#!/usr/bin/env -S npx tsx
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { Agent } from "./lib/agents.ts";
import { AGENTS, agentCommand, buildPrompt, parseUsage } from "./lib/agents.ts";
import { run, which } from "./lib/exec.ts";
import type { TaskResult } from "./lib/report.ts";
import { compare, readResults, summarize } from "./lib/report.ts";
import { atTarget, diffStats, installedVersion } from "./lib/score.ts";
import { makeEnv, prepare, snapshot } from "./lib/setup.ts";
import type { Skill } from "./lib/skill.ts";
import { interpretAudit, interpretVerify, makeSkill, tscErrors } from "./lib/skill.ts";
import type { Task } from "./lib/tasks.ts";
import { loadTasks, resolveTaskSource, slug } from "./lib/tasks.ts";

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EVALS_DIR, "..");

const USAGE = `Usage:
  run.ts --agent <claude|codex|gemini|custom|upgrade-only> [options]
  run.ts summarize <results-dir>
  run.ts compare <results-dir-A|legacy> <results-dir-B>

Run options:
  --agent-cmd "<cmd>"   Shell command for --agent custom (or SAFEBUMP_AGENT_CMD). Gets
                        SAFEBUMP_PROMPT_FILE, SAFEBUMP_REPORT_FILE, SAFEBUMP_PROJECT_DIR, SAFEBUMP_SKILL_DIR
  --tasks <file|url>    Task list (default: swe-bump-bench, pinned)
  --filter <regex>      Only task ids matching this
  --limit N             At most N tasks (after --filter)
  --concurrency N       Tasks in parallel (default 1)
  --timeout-min N       Agent time limit per task (default 45)
  --out <dir>           Results dir (default evals/results/<timestamp>-<agent>). Re-using one
                        resumes it: tasks already scored there are skipped
  --work-dir <dir>      Where repos are cloned (default $TMPDIR/safebump-evals/<run>). Must be
                        outside this repo
  --skill <path>        Skill directory (default skills/safebump in this repo)
  --dry-run             Everything except invoking the agent
  --task-node           Install deps under the task's nodeVersion via nvm (if ~/.nvm exists)
  --keep-work           Keep each task's work dir (repo + node_modules) after scoring
  --rerun               With an existing --out, re-run tasks already in results.jsonl

Agents run with permissions bypassed. Run this in a container or VM.
`;

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: "string" },
      "agent-cmd": { type: "string" },
      tasks: { type: "string" },
      filter: { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string", default: "1" },
      "timeout-min": { type: "string", default: "45" },
      out: { type: "string" },
      "work-dir": { type: "string" },
      skill: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "task-node": { type: "boolean", default: false },
      "keep-work": { type: "boolean", default: false },
      rerun: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) return console.log(USAGE);
  if (positionals[0] === "summarize") {
    const dir = positionals[1];
    if (!dir) throw new Error(USAGE);
    const md = summarize(readResults(dir), readConfig(dir));
    writeFileSync(path.join(dir, "summary.md"), md);
    return console.log(md);
  }
  if (positionals[0] === "compare") {
    const [, a, b] = positionals;
    if (!a || !b) throw new Error(USAGE);
    return console.log(await compare(a, b));
  }
  if (positionals.length > 0) throw new Error(`unknown command ${positionals[0]}\n\n${USAGE}`);

  const agent = values.agent as Agent | undefined;
  if (!agent || !AGENTS.includes(agent)) throw new Error(`--agent is required\n\n${USAGE}`);
  const agentCmd = values["agent-cmd"] ?? process.env.SAFEBUMP_AGENT_CMD;
  if (agent === "custom" && !agentCmd) throw new Error("--agent custom needs --agent-cmd");
  const dryRun = values["dry-run"];
  if (!dryRun && agent !== "custom" && agent !== "upgrade-only" && !(await which(agent))) {
    throw new Error(`${agent} is not on PATH`);
  }

  const skillDir = path.resolve(values.skill ?? path.join(REPO_ROOT, "skills", "safebump"));
  if (!existsSync(path.join(skillDir, "scripts", "safebump"))) {
    throw new Error(`no skill at ${skillDir} (expected scripts/safebump)`);
  }

  const taskSource = resolveTaskSource(values.tasks);
  let tasks = await loadTasks(taskSource);
  if (values.filter) {
    const re = new RegExp(values.filter);
    tasks = tasks.filter((t) => re.test(t.id));
  }
  if (values.limit) tasks = tasks.slice(0, Number(values.limit));
  if (tasks.length === 0) throw new Error("no tasks selected");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = path.resolve(values.out ?? path.join(EVALS_DIR, "results", `${stamp}-${agent}${dryRun ? "-dry" : ""}`));
  mkdirSync(out, { recursive: true });
  const workRoot = path.resolve(values["work-dir"] ?? path.join(tmpdir(), "safebump-evals", path.basename(out)));
  if (!path.relative(REPO_ROOT, workRoot).startsWith("..")) {
    throw new Error(`--work-dir ${workRoot} is inside ${REPO_ROOT}; agents must not run inside this repo`);
  }
  mkdirSync(workRoot, { recursive: true });

  const done = new Set(
    values.rerun ? [] : readResults(out).filter((r) => r.status === "scored").map((r) => r.id),
  );
  const todo = tasks.filter((t) => !done.has(t.id));

  const skillVersion = /version:\s*"?([\w.-]+)/.exec(readFileSync(path.join(skillDir, "SKILL.md"), "utf8"))?.[1];
  const gitRev = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: skillDir });
  const gitDirty = await run("git", ["status", "--porcelain", "--", "."], { cwd: skillDir });
  const config = {
    agent,
    agentCmd,
    skill: skillDir,
    skillVersion: `${skillVersion ?? "?"} @ ${gitRev.stdout.trim() || "?"}${gitDirty.stdout.trim() ? " (dirty)" : ""}`,
    tasks: taskSource === resolveTaskSource(undefined) ? `swe-bump-bench ${taskSource}` : taskSource,
    filter: values.filter,
    limit: values.limit,
    timeoutMin: Number(values["timeout-min"]),
    dryRun,
    node: process.version,
    workRoot,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(out, "config.json"), JSON.stringify(config, null, 2));

  const env = await makeEnv(workRoot);
  const skill = makeSkill(skillDir, env);
  // first run of the wrapper installs the skill's deps; do it once, not per worker
  await run(path.join(skillDir, "scripts", "safebump"), ["--help"], { cwd: skillDir, env });

  console.error(
    `${todo.length} task(s) to run (${tasks.length - todo.length} already in ${out}), agent ${agent}${dryRun ? " [dry run]" : ""}, work dir ${workRoot}`,
  );

  const ctx: Ctx = {
    agent,
    agentCmd,
    dryRun,
    skillDir,
    skill,
    env,
    out,
    workRoot,
    timeoutMs: Number(values["timeout-min"]) * 60_000,
    taskNode: values["task-node"],
    keepWork: values["keep-work"],
  };
  const queue = [...todo];
  let finished = 0;
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const r = await runTask(t, ctx);
      appendFileSync(path.join(out, "results.jsonl"), JSON.stringify(r) + "\n");
      finished++;
      console.error(
        `[${finished}/${todo.length}] ${r.pass ? "PASS" : r.status === "error" ? "ERROR" : "fail"} ${r.id}` +
          (r.error ? `: ${r.error.split("\n")[0]}` : r.score ? ` (target ${r.score.atTarget}, tsc ${r.baseline?.tscErrors}→${r.score.tscErrors}, verify ${r.score.verify.status}, audit ${r.score.audit.status})` : ""),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker));

  const md = summarize(readResults(out), config);
  writeFileSync(path.join(out, "summary.md"), md);
  console.log(md);
  console.error(`Results: ${out}`);
};

type Ctx = {
  agent: Agent;
  agentCmd?: string;
  dryRun: boolean;
  skillDir: string;
  skill: Skill;
  env: NodeJS.ProcessEnv;
  out: string;
  workRoot: string;
  timeoutMs: number;
  taskNode: boolean;
  keepWork: boolean;
};

const readConfig = (dir: string): Record<string, unknown> => {
  const f = path.join(dir, "config.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>) : {};
};

const runTask = async (task: Task, ctx: Ctx): Promise<TaskResult> => {
  const resultsDir = path.join(ctx.out, "tasks", slug(task.id));
  const taskDir = path.join(ctx.workRoot, slug(task.id));
  rmSync(resultsDir, { recursive: true, force: true });
  rmSync(taskDir, { recursive: true, force: true });
  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(taskDir, { recursive: true });
  const log = path.join(resultsDir, "harness.log");
  const base: TaskResult = {
    id: task.id,
    package: task.package,
    versionTo: task.versionTo,
    source: task.path ?? `${task.repo ?? `${task.owner}/${task.name}`}@${task.commit}`,
    agent: ctx.agent,
    startedAt: new Date().toISOString(),
    status: "error",
    pass: false,
    legacyPass: false,
  };

  try {
    // 1. clone + install
    let t0 = Date.now();
    const prep = await prepare(task, taskDir, ctx.env, { log, taskNode: ctx.taskNode });
    base.setup = {
      pkgManager: prep.pkgManager,
      installCommand: prep.installCommand,
      nodeWarning: prep.nodeWarning,
      ms: Date.now() - t0,
    };
    const project = prep.projectDir;
    const repo = path.join(taskDir, "repo");

    // 2. baseline, before the upgrade
    t0 = Date.now();
    const vb = await ctx.skill(project, ["verify", "baseline"], { log });
    const before = await tscErrors(ctx.skill, project, log);
    base.baseline = {
      tscErrors: before.count,
      tscSample: before.sample,
      verify: !vb.available ? "unavailable" : vb.code === 0 ? "recorded" : "failed",
      ms: Date.now() - t0,
    };
    const baseSha = await snapshot(repo, ctx.env, log);
    // the agent is told to record its own baseline too; grade against ours,
    // which was taken before it touched anything
    const baselineFile = path.join(project, ".safebump", "baseline.json");
    const savedBaseline = existsSync(baselineFile) ? readFileSync(baselineFile) : undefined;

    // 3. the agent
    const reportFile = path.join(resultsDir, "report.md");
    const promptFile = path.join(resultsDir, "prompt.md");
    const prompt = buildPrompt(task, ctx.skillDir, project, reportFile);
    writeFileSync(promptFile, prompt);
    let agentRun: NonNullable<TaskResult["agentRun"]>;
    if (ctx.dryRun) {
      agentRun = { skipped: true, exitCode: null, timedOut: false, ms: 0, usage: {}, reportWritten: false };
    } else if (ctx.agent === "upgrade-only") {
      // control: apply the version bump, fix nothing
      const r = await ctx.skill(project, ["upgrade", `${task.package}@${task.versionTo}`], {
        log: path.join(resultsDir, "agent.log"),
        timeoutMs: ctx.timeoutMs,
      });
      agentRun = { skipped: false, exitCode: r.code, timedOut: false, ms: r.ms, usage: {}, reportWritten: false };
    } else {
      const { cmd, args } = agentCommand(ctx.agent, prompt, ctx.agentCmd);
      const r = await run(cmd, args, {
        cwd: project,
        env: {
          ...ctx.env,
          SAFEBUMP_PROMPT_FILE: promptFile,
          SAFEBUMP_REPORT_FILE: reportFile,
          SAFEBUMP_PROJECT_DIR: project,
          SAFEBUMP_SKILL_DIR: ctx.skillDir,
        },
        timeoutMs: ctx.timeoutMs,
        log: path.join(resultsDir, "agent.log"),
      });
      agentRun = {
        skipped: false,
        exitCode: r.code,
        timedOut: r.timedOut,
        ms: r.ms,
        usage: parseUsage(ctx.agent, r.stdout),
        reportWritten: existsSync(reportFile),
      };
    }
    base.agentRun = agentRun;

    // 4. score, deterministically, with the skill's own tools
    t0 = Date.now();
    const version = installedVersion(project, task.package);
    const after = await tscErrors(ctx.skill, project, log);
    if (savedBaseline) {
      mkdirSync(path.dirname(baselineFile), { recursive: true });
      writeFileSync(baselineFile, savedBaseline);
    }
    const verify = interpretVerify(await ctx.skill(project, ["verify"], { log }));
    const audit = interpretAudit(await ctx.skill(project, ["audit", baseSha], { log }));
    const diff = await diffStats(repo, baseSha, ctx.env, path.join(resultsDir, "diff.patch"));
    const target = atTarget(version, task.versionTo);
    const baselineErrors = before.count ?? 0;
    const typecheckClean =
      after.count !== null && (after.count === 0 || (baselineErrors > 0 && after.count <= baselineErrors));
    base.score = {
      installedVersion: version,
      atTarget: target,
      tscErrors: after.count,
      tscSample: after.sample,
      typecheckClean,
      verify,
      audit,
      diff,
      ms: Date.now() - t0,
    };
    base.status = "scored";
    base.pass = target && typecheckClean && verify.status !== "failed" && audit.status !== "findings";
    base.legacyPass = target && after.count !== null && after.count <= baselineErrors;
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
    appendFileSync(log, `\nHARNESS ERROR: ${base.error}\n`);
  } finally {
    if (!ctx.keepWork) rmSync(taskDir, { recursive: true, force: true });
  }
  writeFileSync(path.join(resultsDir, "result.json"), JSON.stringify(base, null, 2));
  return base;
};

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
