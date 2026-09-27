import { z } from "zod";

export const TIERS = ["fast", "fast-thinking", "standard", "deep"] as const;
export const Tier = z.enum(TIERS);
export type Tier = z.infer<typeof Tier>;

export const Complexity = z.enum(["low", "medium", "high"]);
export type Complexity = z.infer<typeof Complexity>;

/** A2A-aligned task states. `submitted` with unmet dependencies is "waiting" (derived). */
export const TASK_STATUSES = [
  "submitted",
  "working",
  "input-required",
  "completed",
  "failed",
  "canceled",
  "rejected",
] as const;
export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "canceled", "rejected"]);
export const isTerminalStatus = (status: TaskStatus): boolean => TERMINAL_STATUSES.has(status);

export const ArtifactRef = z.object({
  namespace: z.array(z.string()),
  key: z.string(),
  bytes: z.number().int().nonnegative(),
  mime: z.string(),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export const Usage = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  reasoningTokens: z.number().nonnegative(),
  cachedTokens: z.number().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  modelCalls: 0,
  toolCalls: 0,
  costUsd: 0,
});

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    modelCalls: a.modelCalls + b.modelCalls,
    toolCalls: a.toolCalls + b.toolCalls,
    costUsd: a.costUsd + b.costUsd,
  };
}

/** a minus b, floored at zero (for splitting a combined total back into its parts). */
export function subtractUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    reasoningTokens: Math.max(0, a.reasoningTokens - b.reasoningTokens),
    cachedTokens: Math.max(0, a.cachedTokens - b.cachedTokens),
    modelCalls: Math.max(0, a.modelCalls - b.modelCalls),
    toolCalls: Math.max(0, a.toolCalls - b.toolCalls),
    costUsd: Math.max(0, a.costUsd - b.costUsd),
  };
}

/** Usage of one model call group, with the model and tier that produced it. */
export const ModelUsage = z.object({ tier: Tier, model: z.string(), usage: Usage });
export type ModelUsage = z.infer<typeof ModelUsage>;

export const Source = z.object({
  title: z.string(),
  url: z.string().nullable(),
});
export type Source = z.infer<typeof Source>;

export const TraceRef = z.object({
  traceId: z.string(),
  spanId: z.string(),
});
export type TraceRef = z.infer<typeof TraceRef>;
