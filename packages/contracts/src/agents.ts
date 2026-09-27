import { z } from "zod";
import { Tier } from "./common.js";
import { EvaluationMode } from "./task.js";

/** Public (prompt-free) view of an agent card, served by the orchestrator's catalog route. */
export const AgentCardSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  persona: z.string(),
  capabilities: z.array(z.string()),
  tools: z.array(z.string()),
  skills: z.array(z.string()),
  model: z.object({ defaultTier: Tier, minTier: Tier, maxTier: Tier }),
  evaluation: EvaluationMode,
});
export type AgentCardSummary = z.infer<typeof AgentCardSummary>;

export const SkillSummary = z.object({
  name: z.string(),
  description: z.string(),
  location: z.string(),
  resources: z.array(z.string()),
});
export type SkillSummary = z.infer<typeof SkillSummary>;

export const TierSummary = z.object({
  tier: Tier,
  model: z.string(),
  thinking: z.string(),
  alternate: z.string().nullable(),
});
export type TierSummary = z.infer<typeof TierSummary>;

export const McpServerStatus = z.enum(["disabled", "misconfigured", "idle", "connecting", "connected", "failed"]);
export type McpServerStatus = z.infer<typeof McpServerStatus>;

export const McpToolSummary = z.object({ name: z.string(), exposedName: z.string(), description: z.string() });
export type McpToolSummary = z.infer<typeof McpToolSummary>;

/** One MCP tool server as the status panel sees it. Never carries header values, full URLs or session ids. */
export const McpServerSummary = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  host: z.string().nullable(),
  transport: z.enum(["auto", "http", "sse"]),
  activeTransport: z.enum(["http", "sse"]).nullable(),
  enabled: z.boolean(),
  status: McpServerStatus,
  detail: z.string().nullable(),
  lastError: z.string().nullable(),
  lastConnectedAt: z.string().nullable(),
  nextRetryAt: z.string().nullable(),
  tools: z.array(McpToolSummary),
  skippedTools: z.array(z.object({ name: z.string(), reason: z.string() })),
  /** Problems with this server’s argument guards, e.g. a guard naming a tool the server does not offer. */
  guardWarnings: z.array(z.string()).default([]),
  usedBy: z.array(z.object({ agentId: z.string(), refs: z.array(z.string()), missing: z.array(z.string()) })),
});
export type McpServerSummary = z.infer<typeof McpServerSummary>;

export const McpStatus = z.object({
  enabled: z.boolean(),
  disabledReason: z.string().nullable(),
  servers: z.array(McpServerSummary),
});
export type McpStatus = z.infer<typeof McpStatus>;

/** Drops the `<tool_output …>` framing MCP results carry for the model, so people see just the content. */
export const unwrapToolOutput = (text: string): string => text.replace(/^<tool_output\b[^>]*>\n?/, "").replace(/\n?<\/tool_output>\s*$/, "");

const EXPOSED_MCP_TOOL = /^mcp__([a-z][a-z0-9-]{0,23})__(.+)$/;

/** "mcp__deepwiki__ask_wiki_question" reads as "deepwiki: ask_wiki_question"; other names are unchanged. */
export function formatToolName(name: string): string {
  const match = EXPOSED_MCP_TOOL.exec(name);
  return match ? `${match[1]}: ${match[2]}` : name;
}

/** Which models the orchestrator runs: real Gemini, or the deterministic offline demo stand-ins. */
export const CatalogMode = z.enum(["live", "offline"]);
export type CatalogMode = z.infer<typeof CatalogMode>;

export const CatalogResponse = z.object({
  agents: z.array(AgentCardSummary),
  skills: z.array(SkillSummary),
  tiers: z.array(TierSummary),
  roles: z.record(z.string(), Tier),
  guards: z.record(z.string(), z.number()),
  hitlDefaults: z.object({ clarify: z.boolean(), approvePlan: z.boolean(), humanReview: z.boolean() }),
  faultsEnabled: z.boolean(),
  mode: CatalogMode,
  /** MCP tool servers. Absent when talking to an orchestrator without MCP support. */
  mcp: McpStatus.optional(),
});
export type CatalogResponse = z.infer<typeof CatalogResponse>;
