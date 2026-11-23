import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { createInterface } from "readline/promises";
import { stringify } from "yaml";

import type { FixAgent, Provider, SafebumpConfig } from "./config";
import { AGENT_PROVIDERS, AGENTS, CONFIG_FILE, defaultConfig, PROVIDERS, validateConfig } from "./config";
import { githubWorkflow, gitlabCi, setupChecklist } from "./ci-gen";
import { renovateConfig } from "./renovate";
import { run } from "./subprocess";

// `safebump init`: a few questions, then safebump.yml, the pipeline and a
// renovate.json, plus exactly what to set up on the CI platform.

export type InitAnswers = Partial<{
  platform: "github" | "gitlab";
  mode: "deterministic" | "ai";
  provider: Provider;
  model: string;
  region: string;
  project: string;
  baseURL: string;
  agent: FixAgent;
  review: boolean;
  fix: boolean;
}>;

const detectPlatform = async (root: string) => {
  const remote = (await run("git remote get-url origin", { cwd: root })).stdout;
  return /gitlab/i.test(remote) ? "gitlab" : "github";
};

const ask = async (
  rl: ReturnType<typeof createInterface>,
  question: string,
  options: readonly string[] | undefined,
  fallback: string,
) => {
  const hint = options ? ` (${options.join(" / ")})` : "";
  const answer = (await rl.question(`${question}${hint} [${fallback}]: `)).trim();
  const value = answer || fallback;
  if (options && !options.includes(value)) {
    console.log(`  "${value}" isn't one of ${options.join(", ")}; using ${fallback}`);
    return fallback;
  }
  return value;
};

export const buildConfig = async (root: string, given: InitAnswers, interactive: boolean): Promise<SafebumpConfig> => {
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const pick = async <T extends string>(key: keyof InitAnswers, q: string, opts: readonly T[] | undefined, fallback: T) =>
    ((given[key] as T | undefined) ?? (rl ? ((await ask(rl, q, opts, fallback)) as T) : fallback));
  try {
    const platform = await pick("platform", "CI platform", ["github", "gitlab"] as const, await detectPlatform(root));
    const mode = await pick("mode", "Mode: deterministic (no AI, no LLM cost) or ai (agents review and fix, opt-in)", ["deterministic", "ai"] as const, "deterministic");
    const config: SafebumpConfig = { ...defaultConfig(), mode, ci: { ...defaultConfig().ci, platform } };
    if (mode === "ai") {
      const provider = await pick("provider", "AI provider", PROVIDERS, "anthropic");
      const model = await pick("model", "Model id (as your provider names it)", undefined, provider === "anthropic" ? "claude-sonnet-5-5" : "");
      const region = ["bedrock", "vertex"].includes(provider) ? await pick("region", "Region", undefined, provider === "bedrock" ? "us-east-1" : "us-east5") : undefined;
      const project = provider === "vertex" ? await pick("project", "Google Cloud project id", undefined, "") : undefined;
      const baseURL = ["azure-openai", "openai-compatible", "foundry"].includes(provider)
        ? await pick("baseURL", provider === "azure-openai" ? "Azure resource URL (https://<resource>.openai.azure.com)" : "Endpoint base URL", undefined, "")
        : undefined;
      const compatible = AGENTS.filter((a) => a !== "custom" && AGENT_PROVIDERS[a].includes(provider));
      const agent = await pick("agent", "Coding agent for fix mode", compatible, compatible[0] ?? "opencode");
      const review = given.review ?? (rl ? (await ask(rl, "Agent review of medium/high-risk updates", ["yes", "no"], provider === "foundry" ? "no" : "yes")) === "yes" : provider !== "foundry");
      const fix = given.fix ?? (rl ? (await ask(rl, "Agent fixes for broken or untested upgrades", ["yes", "no"], "yes")) === "yes" : true);
      config.ai = {
        provider,
        model,
        region,
        project,
        baseURL,
        review: { enabled: review, minRisk: "medium", skipPatch: true },
        fix: { enabled: fix, agent },
      };
    }
    return config;
  } finally {
    rl?.close();
  }
};

export const writeInit = (root: string, config: SafebumpConfig, options: { force?: boolean; ciOnly?: boolean }) => {
  const written: string[] = [];
  const skipped: string[] = [];
  const write = (rel: string, content: string, overwrite: boolean) => {
    const file = path.join(root, rel);
    if (existsSync(file) && !overwrite) {
      skipped.push(rel);
      return;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    written.push(rel);
  };

  if (!options.ciOnly) {
    write(
      CONFIG_FILE,
      `# safebump configuration. Docs: https://github.com/WilliamConnatser/safebump\n# No secrets here: credentials come from your CI platform (secrets or OIDC).\n${stringify(config)}`,
      !!options.force,
    );
  }
  if (config.ci.platform === "github") {
    write(".github/workflows/safebump.yml", githubWorkflow(config), true);
  } else if (existsSync(path.join(root, ".gitlab-ci.yml"))) {
    // never rewrite someone's pipeline: ship an include instead
    write(".gitlab/safebump.gitlab-ci.yml", gitlabCi(config), true);
  } else {
    write(".gitlab-ci.yml", gitlabCi(config), true);
  }
  if (!options.ciOnly) write("renovate.json", `${JSON.stringify(renovateConfig(root), null, 2)}\n`, false);
  return { written, skipped };
};

export const runInit = async (root: string, given: InitAnswers, options: { interactive: boolean; force?: boolean; ciOnly?: boolean }) => {
  const config = await buildConfig(root, given, options.interactive);
  const { problems } = validateConfig(JSON.parse(JSON.stringify(config)));
  const files = writeInit(root, config, options);
  return { config, problems, ...files, checklist: setupChecklist(config) };
};
