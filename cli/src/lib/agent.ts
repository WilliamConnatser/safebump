import { spawn } from "child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { prepareBase, removeBase } from "./base-worktree";
import { resolveChecker } from "./checker";
import type { CiReport } from "./ci";
import { loadCiReport, postCi, runCi, saveCiReport } from "./ci";
import type { SafebumpConfig } from "./config";
import { detectForge, MARKERS } from "./forge";
import { skillDir } from "./paths";
import { buildReviewBrief } from "./review-brief";
import { stateDir } from "./state";
import { run } from "./subprocess";

// `safebump agent`: the AI half, opt-in through safebump.yml (mode: ai).
//   review: the built-in reviewer (AI SDK, sandboxed tools, any provider)
//   fix:    a coding agent. --prepare writes the prompt and the base
//           checkout; on GitHub a vendor action runs the agent, elsewhere
//           --run launches its CLI; --finish re-assures, commits and posts.

type State = { base: string; baseDir?: string; promptFile: string; reportFile: string };

const agentDir = (projectRoot: string) => {
  const dir = path.join(stateDir(projectRoot), "agent");
  mkdirSync(dir, { recursive: true });
  return dir;
};
const stateFile = (projectRoot: string) => path.join(agentDir(projectRoot), "state.json");
const loadState = (projectRoot: string): State | undefined => {
  try {
    return JSON.parse(readFileSync(stateFile(projectRoot), "utf-8")) as State;
  } catch {
    return undefined;
  }
};

const requireAi = (config: SafebumpConfig) => {
  if (config.mode !== "ai" || !config.ai) {
    throw new Error("AI is off for this repo: set `mode: ai` and an `ai:` section in safebump.yml (see `safebump init`).");
  }
  return config.ai;
};

const githubOutput = (key: string, value: string) => {
  if (!process.env.GITHUB_OUTPUT) return;
  const delim = `SAFEBUMP_${Math.random().toString(36).slice(2)}`;
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<${delim}\n${value}\n${delim}\n`);
};

// ---- review ----

const RANK = { low: 0, medium: 1, high: 2 } as const;

export const runReviewMode = async (
  projectRoot: string,
  config: SafebumpConfig,
  options: { base: string; post: boolean; timeoutMs?: number },
) => {
  const ai = requireAi(config);
  const dir = agentDir(projectRoot);
  const ci = loadCiReport(projectRoot);
  const briefPath = path.join(dir, "brief.md");
  const reportPath = path.join(dir, "ci-report.md");
  writeFileSync(reportPath, ci?.markdown ?? "(no assurance report: run `safebump ci` first)");
  writeFileSync(
    briefPath,
    await buildReviewBrief(projectRoot, { base: options.base, coverage: config.ci.coverage, timeoutMs: options.timeoutMs }),
  );

  // only in AI mode: keeps the AI SDK out of the deterministic bundle
  const { runReview } = await import("./ai/reviewer");
  const result = await runReview(projectRoot, {
    config: {
      provider: ai.provider as Exclude<typeof ai.provider, "foundry">,
      model: ai.model,
      region: ai.region,
      project: ai.project,
      baseURL: ai.baseURL,
      apiKeyEnv: ai.provider === "openai-compatible" ? "SAFEBUMP_AI_API_KEY" : undefined,
    },
    briefPath,
    reportPath,
  });
  writeFileSync(path.join(dir, "review.json"), JSON.stringify(result.review, null, 2));
  writeFileSync(path.join(dir, "review.md"), result.markdown);

  // the agent's grade can raise the checked risk, never lower it
  const checked = ci?.risk ?? "medium";
  const agent = result.review.risk;
  const final = RANK[agent] > RANK[checked] ? agent : checked;
  const body = [
    `## safebump review: ${final} risk`,
    "",
    agent !== final ? `_The agent graded this ${agent}; the checked risk (${checked}) stands._\n` : "",
    result.markdown,
    "",
    `<sub>${ai.provider} · ${ai.model} · ${result.usage.steps} steps${result.usage.inputTokens ? ` · ${result.usage.inputTokens} in / ${result.usage.outputTokens ?? 0} out tokens` : ""}</sub>`,
  ].join("\n");

  if (options.post) {
    const forge = detectForge();
    if (forge) {
      await forge.upsertComment(MARKERS.review, body);
      await forge.addLabel(`safebump:${final}-risk`).catch(() => undefined);
    }
  }
  if (result.filesWritten.length > 0 && ci) {
    await finishFix(projectRoot, config, { base: options.base, post: options.post, message: "test: characterize dependency call sites (safebump review)" });
  }
  return { ...result, final, body };
};

// ---- fix ----

export const prepareFix = async (projectRoot: string, config: SafebumpConfig, options: { base: string; checker?: string }) => {
  requireAi(config);
  const dir = agentDir(projectRoot);
  // a checkout of the base branch: characterization tests are proven there,
  // on the old version, before the agent touches the upgrade
  const base = await prepareBase(projectRoot, options.base, {
    dir: mkdtempSync(path.join(tmpdir(), "safebump-base-")),
    checkerOverride: options.checker,
  });
  const ci = loadCiReport(projectRoot);
  const reportFile = path.join(dir, "ci-report.md");
  writeFileSync(reportFile, ci?.markdown ?? "");
  const briefPath = path.join(dir, "brief.md");
  writeFileSync(briefPath, await buildReviewBrief(projectRoot, { base: options.base, coverage: false }));
  const skill = skillDir();
  const prompt = [
    `Read and follow the skill at ${path.join(skill, "SKILL.md")}, in unattended mode, section "CI fix mode".`,
    "",
    "This is a dependency-update PR. The base branch is checked out, with its dependencies installed, at:",
    `  ${base.projectDir}`,
    `safebump's assurance report is at ${reportFile}; the review brief (APIs used, changes, release notes) is at ${briefPath}.`,
    `The safebump CLI is: node ${path.join(skill, "scripts", "safebump.mjs")}`,
    "",
    `Write your report to ${path.join(dir, "report.md")}.`,
  ].join("\n");
  const promptFile = path.join(dir, "prompt.md");
  writeFileSync(promptFile, prompt);
  const state: State = { base: options.base, baseDir: base.dir, promptFile, reportFile: path.join(dir, "report.md") };
  writeFileSync(stateFile(projectRoot), JSON.stringify(state, null, 2));
  githubOutput("prompt", prompt);
  githubOutput("prompt_file", path.relative(projectRoot, promptFile));
  return state;
};

// How each fix agent's CLI runs headless, and how it's pointed at a
// provider, from each agent's own docs. GitHub uses the vendors' actions
// instead (see `safebump init`).
const agentCommand = (config: SafebumpConfig, prompt: string, promptFile: string) => {
  const ai = config.ai!;
  const env: Record<string, string> = { SAFEBUMP_PROMPT_FILE: promptFile };
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  switch (ai.fix.agent) {
    case "claude-code": {
      if (ai.provider === "bedrock") Object.assign(env, { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: ai.region ?? "", ANTHROPIC_MODEL: ai.model });
      if (ai.provider === "vertex") Object.assign(env, { CLAUDE_CODE_USE_VERTEX: "1", CLOUD_ML_REGION: ai.region ?? "", ANTHROPIC_VERTEX_PROJECT_ID: ai.project ?? "", ANTHROPIC_MODEL: ai.model });
      if (ai.provider === "foundry") Object.assign(env, { CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_FOUNDRY_BASE_URL: ai.baseURL ?? "" });
      // a throwaway CI VM without push credentials: no permission prompts
      return { command: `npx -y @anthropic-ai/claude-code -p ${q(prompt)} --model ${q(ai.model)} --dangerously-skip-permissions`, env };
    }
    case "codex": {
      if (process.env.OPENAI_API_KEY && !process.env.CODEX_API_KEY) env.CODEX_API_KEY = process.env.OPENAI_API_KEY;
      if (ai.provider === "azure-openai") {
        const home = mkdtempSync(path.join(tmpdir(), "safebump-codex-"));
        writeFileSync(
          path.join(home, "config.toml"),
          [
            `model = ${JSON.stringify(ai.model)}`,
            `model_provider = "azure"`,
            "",
            "[model_providers.azure]",
            `name = "Azure"`,
            // safebump.yml holds the resource URL; the CLI wants .../openai
            `base_url = ${JSON.stringify(`${(ai.baseURL ?? "").replace(/\/$/, "")}/openai`)}`,
            `env_key = "AZURE_OPENAI_API_KEY"`,
            `query_params = { api-version = "2025-04-01-preview" }`,
            `wire_api = "responses"`,
          ].join("\n"),
        );
        env.CODEX_HOME = home;
      }
      return { command: `npx -y @openai/codex exec --sandbox danger-full-access ${ai.provider === "openai" ? `--model ${q(ai.model)} ` : ""}${q(prompt)}`, env };
    }
    case "gemini": {
      if (ai.provider === "vertex") Object.assign(env, { GOOGLE_CLOUD_PROJECT: ai.project ?? "", GOOGLE_CLOUD_LOCATION: ai.region ?? "", GOOGLE_GENAI_USE_VERTEXAI: "true" });
      return { command: `npx -y @google/gemini-cli --approval-mode=yolo -m ${q(ai.model)} -p ${q(prompt)}`, env };
    }
    case "opencode":
      return { command: `npx -y opencode-ai run --model ${q(ai.model)} ${q(prompt)}`, env };
    case "custom":
      return { command: ai.fix.command ?? "", env };
  }
};

export const runFixAgent = async (projectRoot: string, config: SafebumpConfig) => {
  requireAi(config);
  const state = loadState(projectRoot);
  if (!state) throw new Error("run `safebump agent --mode fix --prepare` first");
  const { command, env } = agentCommand(config, readFileSync(state.promptFile, "utf-8"), state.promptFile);
  return new Promise<number>((resolve) => {
    const child = spawn(command, { cwd: projectRoot, shell: true, stdio: "inherit", env: { ...process.env, ...env } });
    child.on("close", (code) => resolve(code ?? 1));
  });
};

// re-run the same assurance on the agent's result, commit, push, post
export const finishFix = async (
  projectRoot: string,
  config: SafebumpConfig,
  options: { base: string; post: boolean; message?: string },
) => {
  const state = loadState(projectRoot);
  if (state?.baseDir && existsSync(state.baseDir)) await removeBase(projectRoot, state.baseDir);

  const r: CiReport = await runCi(projectRoot, {
    base: options.base,
    checker: resolveChecker(projectRoot),
    coverage: config.ci.coverage,
  });
  saveCiReport(projectRoot, r);

  const status = await run("git status --porcelain -- . ':!.safebump'", { cwd: projectRoot });
  if (!status.stdout.trim()) {
    console.log("The agent made no code changes.");
    return { r, pushed: false };
  }
  await run("git add -A -- . ':!.safebump'", { cwd: projectRoot });
  // project git hooks may refuse CI commits; this re-assurance is the gate
  const commit = await run(
    `git -c user.name="safebump[bot]" -c user.email="safebump@users.noreply.github.com" commit --no-verify -m ${JSON.stringify(options.message ?? "fix(deps): adapt code to the dependency upgrade")} -m "Applied by the safebump agent."`,
    { cwd: projectRoot },
  );
  if (commit.code !== 0) throw new Error(`commit failed: ${commit.stderr}`);
  const sha = (await run("git rev-parse HEAD", { cwd: projectRoot })).stdout.trim();

  const forge = options.post ? detectForge() : undefined;
  if (forge) {
    const push = await run(`git push "${forge.pushUrl()}" "HEAD:${forge.branch}"`, { cwd: projectRoot });
    if (push.code !== 0) throw new Error(`push failed: ${push.stderr.replace(/x-access-token:[^@]+@|oauth2:[^@]+@/g, "***@")}`);
    const agentReport = state?.reportFile && existsSync(state.reportFile) ? readFileSync(state.reportFile, "utf-8") : "";
    // a push with GitHub's default token starts no new run, so the
    // statuses for the new commit come from this re-assurance
    await postCi({ ...r, markdown: `${r.markdown}${agentReport ? `\n### What the agent changed\n\n${agentReport}` : ""}` }, sha, { agentChanged: true });
  }
  return { r, pushed: !!forge, sha };
};
