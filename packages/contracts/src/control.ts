import { z } from "zod";
import { Source, Tier, Usage, emptyUsage } from "./common.js";
import { Proposal } from "./outcome.js";

export const HitlSettings = z.object({
  clarify: z.boolean(),
  approvePlan: z.boolean(),
  humanReview: z.boolean(),
});
export type HitlSettings = z.infer<typeof HitlSettings>;

export const DemoFaultKind = z.enum([
  "block_with_prerequisite",
  "reject",
  "transient_error",
  "propose_follow_up",
  "decline",
]);
export type DemoFaultKind = z.infer<typeof DemoFaultKind>;

/** Showcase-only fault injection (honored only when ANALYTAX_ENABLE_FAULTS=true). Applies while attempt <= times. */
export const DemoFault = z.object({
  kind: DemoFaultKind,
  agentId: z.string().nullable().default(null),
  taskTitleIncludes: z.string().nullable().default(null),
  times: z.number().int().positive().default(1),
});
export type DemoFault = z.infer<typeof DemoFault>;

/**
 * Per-run options. Clients send them in the run input as `runOptions` (works with every SDK); LangGraph run
 * `context` is accepted as a fallback. Clamped against config limits by the orchestrator.
 */
/** Per-run MCP switches: turn every tool server off, or just some (by server id from config/mcp.yaml). */
export const RunMcpOptions = z.object({
  enabled: z.boolean().optional(),
  disabled: z.array(z.string()).optional(),
});
export type RunMcpOptions = z.infer<typeof RunMcpOptions>;

/** How one MCP tool server looked when the run started. `off` means this run turned it off. */
export const RunToolServerStatus = z.enum(["connected", "unavailable", "disabled", "misconfigured", "off"]);
export type RunToolServerStatus = z.infer<typeof RunToolServerStatus>;

export const RunToolServer = z.object({
  id: z.string(),
  title: z.string(),
  status: RunToolServerStatus,
  toolCount: z.number().int().nonnegative(),
  tools: z.array(z.string()),
  detail: z.string().nullable(),
});
export type RunToolServer = z.infer<typeof RunToolServer>;

export const RunContext = z.object({
  hitl: HitlSettings.partial().optional(),
  maxConcurrency: z.number().int().positive().optional(),
  deadlineSec: z.number().int().positive().optional(),
  budgetUsd: z.number().positive().optional(),
  demoFaults: z.array(DemoFault).optional(),
  mcp: RunMcpOptions.optional(),
});
export type RunContext = z.infer<typeof RunContext>;

export const RunInput = z.object({
  query: z.string(),
  clarifications: z.array(z.object({ question: z.string(), answer: z.string() })),
  submittedAt: z.string(),
});
export type RunInput = z.infer<typeof RunInput>;

export const RunMeta = z.object({
  runId: z.string().nullable(),
  threadId: z.string().nullable(),
  traceparent: z.string().nullable(),
  traceId: z.string().nullable(),
  startedAt: z.string().nullable(),
  queryHash: z.string().nullable(),
  hitl: HitlSettings.nullable(),
  maxConcurrency: z.number().int().positive().nullable(),
  budgetUsd: z.number().positive().nullable(),
  faultsEnabled: z.boolean(),
  /** MCP tool servers referenced by agent cards, as they stood at intake. Absent on runs from before MCP support. */
  toolServers: z.array(RunToolServer).optional(),
});
export type RunMeta = z.infer<typeof RunMeta>;

export const emptyRunMeta = (): RunMeta => ({
  runId: null,
  threadId: null,
  traceparent: null,
  traceId: null,
  startedAt: null,
  queryHash: null,
  hitl: null,
  maxConcurrency: null,
  budgetUsd: null,
  faultsEnabled: false,
});

export const PlanMeta = z.object({
  version: z.number().int().nonnegative(),
  path: z.enum(["direct", "plan", "fallback"]).nullable(),
  rationale: z.string(),
  synthesisGuidance: z.string(),
  intentHash: z.string().nullable(),
  approved: z.boolean(),
  /** Reviewer feedback from a rejected plan, consumed by the next planning pass. */
  feedback: z.string().nullable(),
  /** Validation errors from the last plan edit submitted during approval. */
  approvalErrors: z.array(z.string()),
  createdAt: z.string().nullable(),
});
export type PlanMeta = z.infer<typeof PlanMeta>;

export const emptyPlanMeta = (): PlanMeta => ({
  version: 0,
  path: null,
  rationale: "",
  synthesisGuidance: "",
  intentHash: null,
  approved: false,
  feedback: null,
  approvalErrors: [],
  createdAt: null,
});

export const DispatchRecord = z.object({
  dispatchId: z.string(),
  taskId: z.string(),
  attempt: z.number().int(),
  wave: z.number().int(),
  agentId: z.string(),
  tier: Tier,
  model: z.string(),
  dispatchedAt: z.string(),
});
export type DispatchRecord = z.infer<typeof DispatchRecord>;

export const ReplanTrigger = z.enum([
  "decompose",
  "proposal_deferred",
  "upstream_failed",
  "ladder_exhausted",
  "deadlock",
  "stall",
  "plan_rejected",
  "human",
]);
export type ReplanTrigger = z.infer<typeof ReplanTrigger>;

export const ReplanRequest = z.object({
  id: z.string(),
  trigger: ReplanTrigger,
  taskId: z.string().nullable(),
  detail: z.string(),
  proposal: Proposal.nullable(),
  dossier: z.string(),
  wave: z.number().int(),
});
export type ReplanRequest = z.infer<typeof ReplanRequest>;

export const HumanRequestKind = z.enum(["task_failed", "needs_input", "stalled"]);
export type HumanRequestKind = z.infer<typeof HumanRequestKind>;

export const HumanDecision = z.enum(["retry", "skip", "answer", "abort"]);
export type HumanDecision = z.infer<typeof HumanDecision>;

export const HumanRequest = z.object({
  id: z.string(),
  kind: HumanRequestKind,
  taskId: z.string().nullable(),
  title: z.string(),
  question: z.string(),
  detail: z.string(),
  options: z.array(HumanDecision),
});
export type HumanRequest = z.infer<typeof HumanRequest>;

export const GuardName = z.enum([
  "max_waves",
  "max_total_tasks",
  "max_spawn_depth",
  "max_replans",
  "max_human_reviews",
  "deadline",
  "budget",
  "stall",
  "auto_spawn_frozen",
  "deadlock",
  "error_loop",
  "block_loop",
]);
export type GuardName = z.infer<typeof GuardName>;

export const GuardTrip = z.object({
  guard: GuardName,
  wave: z.number().int(),
  detail: z.string(),
  at: z.string(),
});
export type GuardTrip = z.infer<typeof GuardTrip>;

export const SynthesisReason = z.enum(["complete", "partial", "aborted", "budget", "deadline", "max_waves", "deadlock", "stall"]);
export type SynthesisReason = z.infer<typeof SynthesisReason>;

export const RouteDecision = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dispatch"), dispatchIds: z.array(z.string()) }),
  z.object({ kind: z.literal("replan") }),
  z.object({ kind: z.literal("human_review") }),
  z.object({ kind: z.literal("synthesize"), reason: SynthesisReason }),
]);
export type RouteDecision = z.infer<typeof RouteDecision>;

export const ControlState = z.object({
  wave: z.number().int().nonnegative(),
  waveStartedAt: z.string().nullable(),
  eventSeq: z.number().int().nonnegative(),
  taskSeq: z.number().int().nonnegative(),
  requestSeq: z.number().int().nonnegative(),
  replans: z.number().int().nonnegative(),
  humanReviews: z.number().int().nonnegative(),
  clarifyRounds: z.number().int().nonnegative(),
  stallCount: z.number().int().nonnegative(),
  lastProgressWave: z.number().int().nonnegative(),
  autoSpawned: z.number().int().nonnegative(),
  usage: Usage,
  deadlineAt: z.string().nullable(),
  spentFingerprints: z.array(z.string()),
  /** Failed tasks whose critical dependents already triggered an `upstream_failed` replan (don't wait twice). */
  upstreamReplanned: z.array(z.string()),
  errorSigCounts: z.record(z.string(), z.number().int()),
  dispatches: z.record(z.string(), DispatchRecord),
  queues: z.object({
    replan: z.array(ReplanRequest),
    human: z.array(HumanRequest),
  }),
  guards: z.object({
    tripped: z.array(GuardTrip),
    autoSpawnFrozen: z.boolean(),
  }),
  /** Per-wave totals for the plan-growth guard (bounded). */
  growth: z.array(z.object({ wave: z.number().int(), total: z.number().int(), completed: z.number().int() })),
  abort: z.object({ reason: z.string() }).nullable(),
  route: RouteDecision.nullable(),
});
export type ControlState = z.infer<typeof ControlState>;

export const initialControl = (): ControlState => ({
  wave: 0,
  waveStartedAt: null,
  eventSeq: 0,
  taskSeq: 0,
  requestSeq: 0,
  replans: 0,
  humanReviews: 0,
  clarifyRounds: 0,
  stallCount: 0,
  lastProgressWave: 0,
  autoSpawned: 0,
  usage: emptyUsage(),
  deadlineAt: null,
  spentFingerprints: [],
  upstreamReplanned: [],
  errorSigCounts: {},
  dispatches: {},
  queues: { replan: [], human: [] },
  guards: { tripped: [], autoSpawnFrozen: false },
  growth: [],
  abort: null,
  route: null,
});

export const FinalAnswer = z.object({
  status: z.enum(["complete", "partial"]),
  answer: z.string(),
  limitations: z.array(z.string()),
  sources: z.array(Source),
  gaps: z.array(z.object({ taskId: z.string(), title: z.string(), reason: z.string() })),
  completedTaskIds: z.array(z.string()),
  producedAt: z.string(),
});
export type FinalAnswer = z.infer<typeof FinalAnswer>;

/** Synthesizer response schema (flat). */
export const SynthesisWire = z.object({
  answer: z
    .string()
    .describe("The final answer in Markdown. Lead with the direct answer; be precise and concise; no process narration"),
  limitations: z
    .array(z.string())
    .describe("Only material gaps or caveats the client must know (empty if none)"),
});
export type SynthesisWire = z.infer<typeof SynthesisWire>;
