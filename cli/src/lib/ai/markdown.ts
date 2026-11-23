import type { ApiVerdict, ReviewJson } from "./types";

// The PR comment: grade and recommendation first, then the evidence a
// reviewer needs to decide in two minutes.

const RISK_LABEL = { low: "LOW", medium: "MEDIUM", high: "HIGH" } as const;
const RECOMMENDATION_LABEL = {
  merge: "merge",
  "merge-after-checks": "merge after the manual checks below",
  "do-not-merge": "do not merge",
} as const;
const VERDICT_ORDER: ApiVerdict[] = ["breaking", "open-risk", "covered", "irrelevant"];
const VERDICT_LABEL: Record<ApiVerdict, string> = {
  breaking: "**breaking**",
  "open-risk": "**open risk**",
  covered: "covered",
  irrelevant: "irrelevant",
};

// Model text is untrusted too (it read release notes): no raw HTML, and no
// images, which would load a URL when the comment is viewed
const safe = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/!\[/g, "!\\[");
// keep a table cell on one line
const cell = (s: string) => safe((s || "–").replace(/\r?\n+/g, " ").replace(/\|/g, "\\|")).trim();
const item = (s: string) => `- ${safe(s.replace(/\r?\n+/g, " ")).trim()}`;

export const renderReviewMarkdown = (review: ReviewJson, meta: { model?: string; filesWritten?: string[] } = {}) => {
  const lines: string[] = [];
  lines.push(
    `**Grade: ${RISK_LABEL[review.risk]} risk** · Recommendation: **${RECOMMENDATION_LABEL[review.recommendation]}**`,
    "",
    safe(review.summary.trim()),
    "",
  );

  const apis = [...review.apis].sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict));
  if (apis.length > 0) {
    lines.push("### Used APIs that changed", "", "| API | Verdict | What changed | How this project uses it | Evidence |", "|---|---|---|---|---|");
    for (const a of apis) {
      lines.push(`| \`${a.api.replace(/`/g, "'").replace(/\r?\n+/g, " ").replace(/\|/g, "\\|")}\` | ${VERDICT_LABEL[a.verdict]} | ${cell(a.change)} | ${cell(a.usage)} | ${cell(a.evidence)} |`);
    }
    lines.push("");
  } else {
    lines.push("No API this project uses changed.", "");
  }

  lines.push("### Manual checks", "");
  lines.push(...(review.manualChecks.length > 0 ? review.manualChecks.map(item) : ["None."]), "");

  lines.push("### Changes made by the reviewer", "");
  lines.push(...(review.changes.length > 0 ? review.changes.map(item) : ["None."]), "");
  const unlisted = (meta.filesWritten ?? []).filter((f) => !review.changes.some((c) => c.includes(f)));
  if (unlisted.length > 0) lines.push(`Also written: ${unlisted.map((f) => `\`${f}\``).join(", ")}`, "");

  if (review.injectionAttempts.length > 0) {
    lines.push(
      "### Prompt-injection attempts",
      "",
      "Text in release notes or package docs that tried to instruct the reviewer. It was ignored.",
      "",
      ...review.injectionAttempts.map((s) => `- \`${s.replace(/\r?\n+/g, " ").replace(/`/g, "'").slice(0, 300)}\``),
      "",
    );
  }

  if (meta.model) lines.push(`<sub>AI review by ${safe(meta.model)}. It can raise the deterministic verdict, never lower it.</sub>`, "");
  return lines.join("\n");
};
