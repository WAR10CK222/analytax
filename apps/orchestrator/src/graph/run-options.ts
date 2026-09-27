import { RunContext, type DemoFault, type HitlSettings } from "@analytax/contracts";
import type { BaseMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { OrchestratorConfig } from "../config/schema.js";

export type ResolvedRunOptions = {
  hitl: HitlSettings;
  maxConcurrency: number;
  deadlineSec: number;
  budgetUsd: number | null;
  demoFaults: DemoFault[];
  /** Per-run MCP switches: every tool server off, or the listed server ids off. */
  mcp: { allOff: boolean; disabled: string[] };
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Merges run options from state input (preferred) and LangGraph run context, clamped to configured limits. */
export function resolveRunOptions(
  fromState: RunContext | null,
  fromContext: unknown,
  config: OrchestratorConfig,
  faultsEnabled: boolean,
): ResolvedRunOptions {
  const contextOptions = RunContext.safeParse(fromContext ?? {});
  const options: RunContext = { ...(contextOptions.success ? contextOptions.data : {}), ...(fromState ?? {}) };
  const hitlOverrides = Object.fromEntries(Object.entries(options.hitl ?? {}).filter(([, value]) => typeof value === "boolean"));
  return {
    hitl: { ...config.hitl, ...hitlOverrides },
    maxConcurrency: clamp(options.maxConcurrency ?? config.guards.maxConcurrency, 1, config.limits.maxConcurrency),
    deadlineSec: clamp(options.deadlineSec ?? config.guards.deadlineSec, 30, config.limits.deadlineSec),
    budgetUsd: options.budgetUsd ?? null,
    demoFaults: faultsEnabled ? (options.demoFaults ?? []) : [],
    mcp: { allOff: options.mcp?.enabled === false, disabled: [...new Set(options.mcp?.disabled ?? [])] },
  };
}

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "")).join("");
  }
  return "";
}

export function latestHumanText(messages: readonly BaseMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.type === "human") return messageText(message.content).trim() || null;
  }
  return null;
}

export const threadIdOf = (config: LangGraphRunnableConfig): string =>
  String(config.configurable?.thread_id ?? config.executionInfo?.threadId ?? "local");

export const runIdOf = (config: LangGraphRunnableConfig): string | null =>
  config.executionInfo?.runId ?? (config as { runId?: string }).runId ?? null;
