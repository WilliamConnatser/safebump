// AI-mode entry, meant to be loaded with `await import("./ai/reviewer")` so
// the AI SDK, zod and provider packages stay out of the deterministic bundle.
// For a static import (config checks without the SDK) use ./ai/index.

export type { AiConfig, AiProvider, ApiVerdict, ReviewJson, ReviewOptions, ReviewResult } from "./types";
export { checkAiConfig, PROVIDERS } from "./config";
export { renderReviewMarkdown } from "./markdown";
export { reviewSchema } from "./schema";
export { ReviewError, runReview } from "./review";
