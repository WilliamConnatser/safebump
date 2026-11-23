import path from "node:path";

import type { Task } from "./tasks.ts";

export const AGENTS = ["claude", "codex", "gemini", "custom", "upgrade-only"] as const;
export type Agent = (typeof AGENTS)[number];

export type Usage = {
  costUsd?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  turns?: number;
};

/** Same shape as the prompt in examples/react-query-v4/.github/workflows/safebump.yml */
export const buildPrompt = (
  task: Task,
  skillDir: string,
  projectDir: string,
  reportFile: string,
) =>
  [
    `Read and follow the skill at ${path.join(skillDir, "SKILL.md")}, in its unattended mode.`,
    "",
    `The project is at ${projectDir} and its dependencies are installed.`,
    `Upgrade ${task.package} to ${task.versionTo}, together with whatever upgrade set the skill's plan requires.`,
    "Then fix the code.",
    task.notes ? `\n${task.notes}\n` : "",
    `Write your report to ${reportFile}.`,
    "",
  ].join("\n");

/**
 * Headless invocation per agent CLI, mirroring the CI workflow's "Fix" step,
 * plus each CLI's machine-readable output mode where it has one so usage can
 * be parsed. `custom` runs a shell command with the prompt's path in
 * $SAFEBUMP_PROMPT_FILE.
 */
export const agentCommand = (
  agent: Agent,
  prompt: string,
  agentCmd?: string,
): { cmd: string; args: string[] } => {
  switch (agent) {
    case "claude":
      return {
        cmd: "claude",
        args: ["-p", prompt, "--dangerously-skip-permissions", "--output-format", "json"],
      };
    case "codex":
      return {
        cmd: "codex",
        args: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--json", prompt],
      };
    case "gemini":
      return { cmd: "gemini", args: ["-p", prompt, "--yolo", "--output-format", "json"] };
    case "custom":
      if (!agentCmd) throw new Error("--agent custom needs --agent-cmd or SAFEBUMP_AGENT_CMD");
      return { cmd: "bash", args: ["-c", agentCmd] };
    case "upgrade-only":
      throw new Error("upgrade-only is run by the harness itself");
  }
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const tryJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** Best effort: whatever token/cost numbers the agent printed. */
export const parseUsage = (agent: Agent, stdout: string): Usage => {
  const trimmed = stdout.trim();
  if (agent === "claude" || agent === "custom") {
    // claude -p --output-format json: one result object
    const last = trimmed.slice(trimmed.lastIndexOf("\n{") + 1);
    const j = (tryJson(trimmed) ?? tryJson(last)) as Record<string, any> | undefined;
    if (j && (j.total_cost_usd !== undefined || j.usage)) {
      const u = j.usage ?? {};
      return {
        costUsd: num(j.total_cost_usd),
        inputTokens:
          (num(u.input_tokens) ?? 0) +
          (num(u.cache_creation_input_tokens) ?? 0) +
          (num(u.cache_read_input_tokens) ?? 0),
        cachedInputTokens: num(u.cache_read_input_tokens),
        outputTokens: num(u.output_tokens),
        turns: num(j.num_turns),
      };
    }
  }
  if (agent === "codex" || agent === "custom") {
    // codex exec --json: JSONL events; usage on turn.completed
    const usage: Usage = {};
    let found = false;
    for (const line of trimmed.split("\n")) {
      const e = tryJson(line) as Record<string, any> | undefined;
      if (e?.type === "turn.completed" && e.usage) {
        found = true;
        usage.inputTokens = (usage.inputTokens ?? 0) + (num(e.usage.input_tokens) ?? 0);
        usage.cachedInputTokens =
          (usage.cachedInputTokens ?? 0) + (num(e.usage.cached_input_tokens) ?? 0);
        usage.outputTokens = (usage.outputTokens ?? 0) + (num(e.usage.output_tokens) ?? 0);
        usage.turns = (usage.turns ?? 0) + 1;
      }
    }
    if (found) return usage;
  }
  if (agent === "gemini" || agent === "custom") {
    // gemini -p --output-format json: {response, stats: {models: {<m>: {tokens}}}}
    const j = tryJson(trimmed) as Record<string, any> | undefined;
    const models = j?.stats?.models;
    if (models && typeof models === "object") {
      const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      for (const m of Object.values(models) as any[]) {
        usage.inputTokens! += num(m?.tokens?.prompt) ?? 0;
        usage.outputTokens! += num(m?.tokens?.candidates) ?? 0;
        usage.cachedInputTokens! += num(m?.tokens?.cached) ?? 0;
      }
      return usage;
    }
  }
  // plain-text fallbacks
  const tokens = /tokens used[:\s]+([\d,]+)/i.exec(stdout)?.[1];
  const cost = /(?:total )?cost[:\s]+\$?([\d.]+)/i.exec(stdout)?.[1];
  return {
    inputTokens: tokens ? Number(tokens.replace(/,/g, "")) : undefined,
    costUsd: cost ? Number(cost) : undefined,
  };
};
