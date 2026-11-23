import { existsSync } from "fs";
import os from "os";
import path from "path";

import type { AiConfig, AiProvider } from "./types";

// Credentials come only from the environment or the provider's standard
// credential chain, never from a config file: the config names *which* env
// var to read (apiKeyEnv), not the key.

export const PROVIDERS: AiProvider[] = [
  "anthropic",
  "bedrock",
  "vertex",
  "foundry",
  "openai",
  "azure-openai",
  "google",
  "openai-compatible",
];

// the env var each provider's SDK reads by default
export const DEFAULT_KEY_ENV: Partial<Record<AiProvider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "azure-openai": "AZURE_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  // optional for these: without a key, foundry uses Entra ID and
  // openai-compatible sends no auth (local servers)
  foundry: "ANTHROPIC_FOUNDRY_API_KEY",
  "openai-compatible": "SAFEBUMP_AI_API_KEY",
};

const env = (name: string) => {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : undefined;
};
const firstEnv = (...names: string[]) => names.map(env).find((v) => v !== undefined);

export const keyEnvName = (config: AiConfig) => config.apiKeyEnv ?? DEFAULT_KEY_ENV[config.provider];
export const apiKeyFor = (config: AiConfig) => {
  const name = keyEnvName(config);
  return name ? env(name) : undefined;
};

export const bedrockRegion = (config: AiConfig) => config.region ?? firstEnv("AWS_REGION", "AWS_DEFAULT_REGION");
export const vertexProject = (config: AiConfig) =>
  config.project ?? firstEnv("GOOGLE_VERTEX_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT");
export const vertexLocation = (config: AiConfig) =>
  config.region ?? firstEnv("GOOGLE_VERTEX_LOCATION", "GOOGLE_CLOUD_LOCATION");
// Foundry's Anthropic endpoint, as the AI SDK wants it (…/anthropic/v1)
export const foundryBaseURL = (config: AiConfig) => {
  const resource = env("ANTHROPIC_FOUNDRY_RESOURCE");
  const base = config.baseURL ?? env("ANTHROPIC_FOUNDRY_BASE_URL") ?? (resource ? `https://${resource}.services.ai.azure.com/anthropic` : undefined);
  if (!base) return undefined;
  const trimmed = base.replace(/\/+$/, "");
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
};

// Anthropic models on Vertex go through the Anthropic partner API
export const isVertexAnthropic = (model: string) => /^(claude|anthropic)/i.test(model);

// any source the AWS default credential chain can use, short of instance
// metadata (which can't be detected without a network call)
const awsCredentialSource = () => {
  if (env("AWS_BEARER_TOKEN_BEDROCK")) return "AWS_BEARER_TOKEN_BEDROCK";
  if (env("AWS_ACCESS_KEY_ID") && env("AWS_SECRET_ACCESS_KEY")) return "AWS_ACCESS_KEY_ID";
  if (env("AWS_WEB_IDENTITY_TOKEN_FILE") && env("AWS_ROLE_ARN")) return "web identity (OIDC)";
  if (env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") || env("AWS_CONTAINER_CREDENTIALS_FULL_URI")) return "container credentials";
  if (env("AWS_PROFILE")) return "AWS_PROFILE";
  const home = os.homedir();
  const files = [env("AWS_SHARED_CREDENTIALS_FILE"), env("AWS_CONFIG_FILE"), path.join(home, ".aws", "credentials"), path.join(home, ".aws", "config")];
  if (files.some((f) => f && existsSync(f))) return "shared config files";
  return undefined;
};

// what DefaultAzureCredential can use (env service principal, workload
// identity, az login after azure/login)
const azureCredentialSource = () => {
  if (env("AZURE_CLIENT_ID") && (env("AZURE_CLIENT_SECRET") || env("AZURE_FEDERATED_TOKEN_FILE") || env("AZURE_CLIENT_CERTIFICATE_PATH"))) return "service principal";
  if (env("AZURE_CLIENT_ID") || env("IDENTITY_ENDPOINT") || env("MSI_ENDPOINT")) return "managed identity";
  const azureDir = env("AZURE_CONFIG_DIR") ?? path.join(os.homedir(), ".azure");
  return existsSync(path.join(azureDir, "azureProfile.json")) ? "az login" : undefined;
};

const googleAdcSource = () => {
  const file = env("GOOGLE_APPLICATION_CREDENTIALS");
  if (file) return existsSync(file) ? "GOOGLE_APPLICATION_CREDENTIALS" : undefined;
  const wellKnown =
    process.platform === "win32"
      ? path.join(env("APPDATA") ?? "", "gcloud", "application_default_credentials.json")
      : path.join(env("CLOUDSDK_CONFIG") ?? path.join(os.homedir(), ".config", "gcloud"), "application_default_credentials.json");
  return existsSync(wellKnown) ? "gcloud application-default credentials" : undefined;
};

// No network: checks the config is complete and a credential source exists.
export const checkAiConfig = (config: AiConfig): { ok: boolean; problems: string[] } => {
  const problems: string[] = [];
  if (!config || typeof config !== "object") return { ok: false, problems: ["no AI config"] };
  if (!PROVIDERS.includes(config.provider)) {
    problems.push(`unknown provider "${String(config.provider)}" (expected one of: ${PROVIDERS.join(", ")})`);
    return { ok: false, problems };
  }
  if (!config.model || typeof config.model !== "string") problems.push("model is not set");
  if (config.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) {
    problems.push(`apiKeyEnv must be the NAME of an environment variable, not a key: "${config.apiKeyEnv.slice(0, 4)}…"`);
  }
  if (config.maxSteps !== undefined && !(Number.isInteger(config.maxSteps) && config.maxSteps > 0)) problems.push("maxSteps must be a positive integer");
  if (config.maxOutputTokens !== undefined && !(Number.isInteger(config.maxOutputTokens) && config.maxOutputTokens > 0)) {
    problems.push("maxOutputTokens must be a positive integer");
  }
  if (config.baseURL !== undefined && !/^https?:\/\/\S+$/.test(config.baseURL)) problems.push(`baseURL is not an http(s) URL: ${config.baseURL}`);

  const needKey = (what = "API key") => {
    const name = keyEnvName(config);
    if (name && !apiKeyFor(config)) problems.push(`${what} missing: set ${name}`);
  };

  switch (config.provider) {
    case "anthropic":
    case "openai":
    case "google":
      needKey();
      break;
    case "azure-openai":
      needKey();
      if (!config.baseURL && !env("AZURE_RESOURCE_NAME")) problems.push("Azure resource missing: set baseURL in the config or AZURE_RESOURCE_NAME");
      break;
    case "foundry":
      if (!foundryBaseURL(config)) problems.push("Foundry endpoint missing: set baseURL in the config or ANTHROPIC_FOUNDRY_BASE_URL");
      if (config.apiKeyEnv) needKey();
      else if (!apiKeyFor(config) && !azureCredentialSource()) {
        problems.push("no Foundry credentials found: set ANTHROPIC_FOUNDRY_API_KEY, or sign in to Azure (azure/login with OIDC, AZURE_CLIENT_ID + AZURE_FEDERATED_TOKEN_FILE, or `az login`)");
      }
      break;
    case "openai-compatible":
      if (!config.baseURL) problems.push("baseURL is required for openai-compatible");
      // local servers often need no key; only check one that was named
      if (config.apiKeyEnv && !apiKeyFor(config)) problems.push(`API key missing: set ${config.apiKeyEnv}`);
      break;
    case "bedrock":
      if (!bedrockRegion(config)) problems.push("AWS region missing: set region in the config or AWS_REGION");
      if (config.apiKeyEnv) needKey("Bedrock API key");
      else if (!awsCredentialSource()) {
        problems.push(
          "no AWS credentials found: set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, OIDC web identity (AWS_ROLE_ARN + AWS_WEB_IDENTITY_TOKEN_FILE, e.g. aws-actions/configure-aws-credentials), AWS_PROFILE, or AWS_BEARER_TOKEN_BEDROCK",
        );
      }
      break;
    case "vertex":
      if (!vertexProject(config)) problems.push("Google Cloud project missing: set project in the config or GOOGLE_VERTEX_PROJECT");
      if (!vertexLocation(config)) problems.push("Vertex location missing: set region in the config or GOOGLE_VERTEX_LOCATION");
      if (config.apiKeyEnv) needKey("Vertex API key");
      else if (!googleAdcSource() && !(env("GOOGLE_VERTEX_API_KEY") && !isVertexAnthropic(config.model ?? ""))) {
        problems.push(
          "no Google credentials found: set GOOGLE_APPLICATION_CREDENTIALS (e.g. google-github-actions/auth with workload identity) or run `gcloud auth application-default login`",
        );
      }
      break;
  }
  return { ok: problems.length === 0, problems };
};

// Values of secret-looking env vars, to scrub from anything the model sees or
// writes, and to hide from test processes the model can cause to run.
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL|AUTH|SESSION|COOKIE|PRIVATE)/i;
export const secretEnvNames = () => Object.keys(process.env).filter((k) => SECRET_NAME.test(k));
export const secretValues = () =>
  secretEnvNames()
    .map((k) => process.env[k] ?? "")
    .filter((v) => v.length >= 8)
    .sort((a, b) => b.length - a.length);
