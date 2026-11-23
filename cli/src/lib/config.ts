import { existsSync, readFileSync } from "fs";
import path from "path";
import { parse } from "yaml";

import { findWorkspaceRoot } from "./workspaces";

// safebump.yml: one place for how safebump runs in this repo. No secrets:
// credentials come from the CI platform (secrets, or OIDC for clouds).

export const PROVIDERS = ["anthropic", "bedrock", "vertex", "foundry", "openai", "azure-openai", "google", "openai-compatible"] as const;
export const AGENTS = ["claude-code", "codex", "gemini", "opencode", "custom"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type FixAgent = (typeof AGENTS)[number];

export type SafebumpConfig = {
  version: 1;
  // deterministic: no LLM anywhere. ai: the review/fix jobs below may run.
  mode: "deterministic" | "ai";
  ci: {
    platform: "github" | "gitlab";
    // fail the required check at this verdict or worse
    failOn: "blocked" | "medium" | "high";
    coverage: boolean;
  };
  ai?: {
    provider: Provider;
    model: string;
    region?: string;
    project?: string;
    baseURL?: string;
    review: { enabled: boolean; minRisk: "medium" | "high"; skipPatch: boolean };
    fix: { enabled: boolean; agent: FixAgent; command?: string };
  };
};

// which fix agents can talk to which providers (each agent's own docs)
export const AGENT_PROVIDERS: Record<FixAgent, Provider[]> = {
  "claude-code": ["anthropic", "bedrock", "vertex", "foundry"],
  codex: ["openai", "azure-openai"],
  gemini: ["google", "vertex"],
  opencode: [...PROVIDERS],
  custom: [...PROVIDERS],
};

export const CONFIG_FILE = "safebump.yml";

export const defaultConfig = (): SafebumpConfig => ({
  version: 1,
  mode: "deterministic",
  ci: { platform: "github", failOn: "blocked", coverage: true },
});

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], field: string, problems: string[], fallback: T): T => {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  problems.push(`${field}: expected one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
  return fallback;
};

export const validateConfig = (raw: unknown): { config: SafebumpConfig; problems: string[] } => {
  const problems: string[] = [];
  const r = (raw ?? {}) as Record<string, any>;
  const base = defaultConfig();
  const config: SafebumpConfig = {
    version: 1,
    mode: oneOf(r.mode, ["deterministic", "ai"] as const, "mode", problems, base.mode),
    ci: {
      platform: oneOf(r.ci?.platform, ["github", "gitlab"] as const, "ci.platform", problems, base.ci.platform),
      failOn: oneOf(r.ci?.failOn, ["blocked", "medium", "high"] as const, "ci.failOn", problems, base.ci.failOn),
      coverage: r.ci?.coverage === undefined ? true : Boolean(r.ci.coverage),
    },
  };
  if (r.ai !== undefined || config.mode === "ai") {
    const ai = (r.ai ?? {}) as Record<string, any>;
    const provider = oneOf(ai.provider, PROVIDERS, "ai.provider", problems, "anthropic");
    const agent = oneOf(ai.fix?.agent, AGENTS, "ai.fix.agent", problems, "claude-code");
    if (typeof ai.model !== "string" || !ai.model) problems.push("ai.model: required (the provider's model id)");
    if ((provider === "bedrock" || provider === "vertex") && !ai.region) problems.push(`ai.region: required for ${provider}`);
    if (provider === "vertex" && !ai.project) problems.push("ai.project: required for vertex");
    if ((provider === "openai-compatible" || provider === "azure-openai" || provider === "foundry") && !ai.baseURL) {
      problems.push(`ai.baseURL: required for ${provider}`);
    }
    const fixEnabled = ai.fix?.enabled === undefined ? true : Boolean(ai.fix.enabled);
    if (fixEnabled && !AGENT_PROVIDERS[agent].includes(provider)) {
      problems.push(`ai.fix.agent: ${agent} can't use provider ${provider} (supported: ${AGENT_PROVIDERS[agent].join(", ")})`);
    }
    const reviewEnabled = ai.review?.enabled === undefined ? true : Boolean(ai.review.enabled);
    if (reviewEnabled && provider === "foundry") {
      problems.push("ai.review: the built-in reviewer doesn't support foundry yet; set ai.review.enabled: false or use another provider");
    }
    if (agent === "custom" && fixEnabled && !ai.fix?.command) problems.push("ai.fix.command: required for the custom agent");
    config.ai = {
      provider,
      model: String(ai.model ?? ""),
      region: ai.region ? String(ai.region) : undefined,
      project: ai.project ? String(ai.project) : undefined,
      baseURL: ai.baseURL ? String(ai.baseURL) : undefined,
      review: {
        enabled: ai.review?.enabled === undefined ? true : Boolean(ai.review.enabled),
        minRisk: oneOf(ai.review?.minRisk, ["medium", "high"] as const, "ai.review.minRisk", problems, "medium"),
        skipPatch: ai.review?.skipPatch === undefined ? true : Boolean(ai.review.skipPatch),
      },
      fix: { enabled: fixEnabled, agent, command: ai.fix?.command ? String(ai.fix.command) : undefined },
    };
  }
  return { config, problems };
};

// safebump.yml at the project, else at the workspace/repo root
export const loadConfig = (projectRoot: string) => {
  const candidates = [projectRoot, findWorkspaceRoot(projectRoot)].filter((d): d is string => !!d);
  for (const dir of candidates) {
    const file = path.join(dir, CONFIG_FILE);
    if (existsSync(file)) {
      const { config, problems } = validateConfig(parse(readFileSync(file, "utf-8")));
      return { file, config, problems };
    }
  }
  return { file: undefined, config: defaultConfig(), problems: [] as string[] };
};
