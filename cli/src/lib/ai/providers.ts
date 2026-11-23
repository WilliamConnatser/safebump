import type { LanguageModel } from "ai";

import { apiKeyFor, bedrockRegion, foundryBaseURL, checkAiConfig, isVertexAnthropic, vertexLocation, vertexProject } from "./config";
import type { AiConfig } from "./types";

// One config, any provider. Each provider package is imported only when
// chosen, so it lands in its own chunk and loads only in AI mode. Keys are
// read from the environment here (and passed explicitly, so the provider
// doesn't need the env var later, while test runs have secrets hidden).

export const createModel = async (config: AiConfig): Promise<LanguageModel> => {
  const check = checkAiConfig(config);
  if (!check.ok) throw new Error(`AI config: ${check.problems.join("; ")}`);
  const apiKey = apiKeyFor(config);

  switch (config.provider) {
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ apiKey, ...(config.baseURL ? { baseURL: config.baseURL } : {}) })(config.model);
    }
    case "foundry": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const baseURL = foundryBaseURL(config);
      // Foundry takes the key as api-key (and x-api-key)
      if (apiKey) return createAnthropic({ baseURL, apiKey, headers: { "api-key": apiKey } })(config.model);
      const { DefaultAzureCredential } = await import("@azure/identity");
      const credential = new DefaultAzureCredential();
      const authToken = async () => {
        const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
        if (!token) throw new Error("Azure returned no token for Cognitive Services");
        return token.token;
      };
      return createAnthropic({ baseURL, authToken })(config.model);
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey, ...(config.baseURL ? { baseURL: config.baseURL } : {}) })(config.model);
    }
    case "azure-openai": {
      const { createAzure } = await import("@ai-sdk/azure");
      // model is the deployment name; resource from baseURL or AZURE_RESOURCE_NAME
      return createAzure({ apiKey, ...(config.baseURL ? { baseURL: config.baseURL } : {}) })(config.model);
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return createGoogleGenerativeAI({ apiKey, ...(config.baseURL ? { baseURL: config.baseURL } : {}) })(config.model);
    }
    case "openai-compatible": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      return createOpenAICompatible({ name: "openai-compatible", baseURL: config.baseURL!, apiKey }).chatModel(config.model);
    }
    case "bedrock": {
      const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
      const region = bedrockRegion(config);
      if (config.apiKeyEnv) return createAmazonBedrock({ region, apiKey })(config.model);
      // AWS_BEARER_TOKEN_BEDROCK is read by the provider itself; otherwise the
      // full AWS default chain: env, SSO/profiles, OIDC web identity, ECS, IMDS
      const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
      return createAmazonBedrock({ region, credentialProvider: fromNodeProviderChain() })(config.model);
    }
    case "vertex": {
      const project = vertexProject(config);
      const location = vertexLocation(config);
      // Google ADC (GOOGLE_APPLICATION_CREDENTIALS, workload identity, gcloud)
      if (isVertexAnthropic(config.model)) {
        const { createVertexAnthropic } = await import("@ai-sdk/google-vertex/anthropic");
        return createVertexAnthropic({ project, location })(config.model);
      }
      const { createVertex } = await import("@ai-sdk/google-vertex");
      return createVertex({ project, location, ...(apiKey ? { apiKey } : {}) })(config.model);
    }
  }
};
