// The AI reviewer's public entry. Safe to import from the CLI statically:
// the AI SDK, zod and the provider packages load only when runReview is
// called (dynamic import, split into chunks by build.mjs).

import type { ReviewOptions, ReviewResult } from "./types";

export type { AiConfig, AiProvider, ApiVerdict, ReviewJson, ReviewOptions, ReviewResult } from "./types";
export { checkAiConfig, PROVIDERS } from "./config";
export { renderReviewMarkdown } from "./markdown";

export const runReview = async (projectRoot: string, options: ReviewOptions): Promise<ReviewResult> => {
  const { runReview: run } = await import("./review");
  return run(projectRoot, options);
};
