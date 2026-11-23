// Types shared by the light entry (index.ts) and the AI-mode chunk. Nothing
// here imports the AI SDK or zod, so the deterministic CLI can import it.

export type AiProvider =
  | "anthropic"
  | "bedrock"
  | "vertex"
  // Claude on Microsoft Foundry (Anthropic Messages API on Azure)
  | "foundry"
  | "openai"
  | "azure-openai"
  | "google"
  | "openai-compatible";

export type AiConfig = {
  provider: AiProvider;
  // the provider's model id (a deployment name for Azure)
  model: string;
  // bedrock / vertex
  region?: string;
  // vertex
  project?: string;
  // openai-compatible, azure-openai and foundry (resource URL)
  baseURL?: string;
  // name of the env var holding the key, when not the provider default
  apiKeyEnv?: string;
  // tool-use step cap (default 40)
  maxSteps?: number;
  maxOutputTokens?: number;
};

export type ApiVerdict = "irrelevant" | "covered" | "open-risk" | "breaking";

// exactly the shape in skills/safebump/references/ci-review.md
export type ReviewJson = {
  risk: "low" | "medium" | "high";
  recommendation: "merge" | "merge-after-checks" | "do-not-merge";
  summary: string;
  apis: { api: string; change: string; usage: string; verdict: ApiVerdict; evidence: string }[];
  manualChecks: string[];
  changes: string[];
  injectionAttempts: string[];
};

export type ReviewResult = {
  review: ReviewJson;
  markdown: string;
  usage: { inputTokens?: number; outputTokens?: number; steps: number };
  filesWritten: string[];
  warnings: string[];
};

export type ReviewOptions = {
  config: AiConfig;
  briefPath: string;
  reportPath?: string;
  // default true
  allowTestWrites?: boolean;
  // total wall-clock limit for the whole review (default 20 minutes)
  timeLimitMs?: number;
};
