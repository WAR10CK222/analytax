import { z } from "zod";
import { TraceRef, type ModelUsage, type Tier, type Usage } from "./common.js";
import type {
  GuardName,
  HitlSettings,
  HumanRequestKind,
  ReplanTrigger,
  RunToolServer,
  SynthesisReason,
} from "./control.js";
import type { IntentAnalysis } from "./intent.js";
import type { OutcomeStatus, ProposalKind } from "./outcome.js";
import type { OpSourceKind, PlanOpType } from "./plan-ops.js";
import type { TaskPreview } from "./task.js";
import type { EvaluatedBy, VerdictDecision } from "./verdict.js";

/** Name used to tag Analytax chunks on the LangGraph `custom` stream. */
export const EVENT_CHANNEL = "analytax" as const;

/** Durable events live in graph state (ordered by `seq`) and survive reloads, history and interrupts. */
export const DURABLE_EVENT_TYPES = [
  "run.started",
  "intent.analyzed",
  "clarification.answered",
  "plan.created",
  "plan.approved",
  "plan.rejected",
  "plan.patched",
  "plan.op_rejected",
  "wave.started",
  "wave.completed",
  "task.dispatched",
  "task.completed",
  "task.requeued",
  "task.retried",
  "task.escalated",
  "task.reassigned",
  "task.blocked",
  "task.input_required",
  "task.canceled",
  "task.failed",
  "task.rejected",
  "task.report_discarded",
  "evaluation.completed",
  "proposal.accepted",
  "proposal.deferred",
  "proposal.dropped",
  "replan.requested",
  "replan.completed",
  "guard.tripped",
  "human.requested",
  "human.resolved",
  "synthesis.started",
  "run.completed",
  "run.failed",
] as const;

/** Ephemeral events are only streamed live (custom stream) from inside running workers. */
export const EPHEMERAL_EVENT_TYPES = [
  "agent.started",
  "agent.finished",
  "agent.model.started",
  "agent.model.finished",
  "agent.tool.started",
  "agent.tool.finished",
  "agent.skill.loaded",
  "agent.thought",
  "evaluation.started",
  "heartbeat",
] as const;

export const EVENT_TYPES = [...DURABLE_EVENT_TYPES, ...EPHEMERAL_EVENT_TYPES] as const;

export type DurableEventType = (typeof DURABLE_EVENT_TYPES)[number];
export type EphemeralEventType = (typeof EPHEMERAL_EVENT_TYPES)[number];
export type EventType = (typeof EVENT_TYPES)[number];

export type PlanDiff = {
  added: TaskPreview[];
  updated: TaskPreview[];
  canceled: string[];
  rewired: { taskId: string; dependsOn: string[] }[];
};

export type TaskCounts = {
  total: number;
  completed: number;
  failed: number;
  canceled: number;
  rejected: number;
};

export type EventDataMap = {
  "run.started": {
    query: string;
    hitl: HitlSettings;
    maxConcurrency: number;
    deadlineAt: string | null;
    faultsEnabled: boolean;
    /** MCP tool servers referenced by agent cards, as they stood at intake. Absent on older events. */
    toolServers?: RunToolServer[];
  };
  "intent.analyzed": { intent: IntentAnalysis; tier: Tier | null; model: string | null; usage: Usage | null };
  "clarification.answered": { questions: string[]; answers: string[] };
  "plan.created": {
    version: number;
    path: "direct" | "plan" | "fallback";
    rationale: string;
    tasks: TaskPreview[];
    tier: Tier | null;
    model: string | null;
    usage: Usage | null;
  };
  "plan.approved": { version: number; edited: boolean };
  "plan.rejected": { feedback: string };
  "plan.patched": {
    version: number;
    source: OpSourceKind;
    reason: string;
    ops: { op: PlanOpType; taskId: string | null; reason: string }[];
    diff: PlanDiff;
  };
  "plan.op_rejected": { op: PlanOpType; taskId: string | null; source: OpSourceKind; errors: string[] };
  "wave.started": { wave: number; dispatchIds: string[] };
  "wave.completed": { wave: number; reports: number; durationMs: number; progress: boolean; stallCount: number };
  "task.dispatched": {
    dispatchId: string;
    attempt: number;
    tier: Tier;
    agentId: string;
    model: string;
    packetTokens: number;
  };
  "task.completed": {
    dispatchId: string;
    attempt: number;
    tier: Tier;
    score: number | null;
    evaluatedBy: EvaluatedBy;
    summary: string;
    degraded: boolean;
  };
  "task.requeued": { dispatchId: string; reason: string; infraRetries: number };
  "task.retried": { dispatchId: string; nextAttempt: number; feedback: string };
  "task.escalated": { dispatchId: string; fromTier: Tier; toTier: Tier; reason: string };
  "task.reassigned": { dispatchId: string; fromAgentId: string; toAgentId: string; reason: string };
  "task.blocked": { dispatchId: string; prerequisiteTaskId: string | null; reason: string };
  "task.input_required": { dispatchId: string; questions: string[] };
  "task.canceled": { reason: string; cascadeFrom: string | null };
  "task.failed": { dispatchId: string | null; reason: string; degraded: boolean };
  "task.rejected": { reason: string };
  "task.report_discarded": { dispatchId: string; reason: string };
  "evaluation.completed": {
    dispatchId: string;
    attempt: number;
    tier: Tier;
    model: string;
    outcomeStatus: OutcomeStatus | null;
    decision: VerdictDecision | null;
    score: number | null;
    evaluatedBy: EvaluatedBy | null;
    unmetCriteria: string[];
    issues: string[];
    error: string | null;
    /** Agent plus judge usage. */
    usage: Usage;
    /** The judge part of `usage`, so per-model totals credit the judge model. Absent on older events. */
    judge?: ModelUsage | null;
    durationMs: number;
  };
  "proposal.accepted": { fromTaskId: string; kind: ProposalKind; title: string; newTaskId: string };
  "proposal.deferred": { fromTaskId: string; kind: ProposalKind; title: string; requestId: string };
  "proposal.dropped": { fromTaskId: string; kind: ProposalKind; title: string; reason: string };
  "replan.requested": { requestId: string; trigger: ReplanTrigger; detail: string };
  "replan.completed": {
    requestIds: string[];
    diagnosis: string;
    applied: number;
    rejected: number;
    fallback: boolean;
    tier: Tier | null;
    model: string | null;
    usage: Usage | null;
  };
  "guard.tripped": { guard: GuardName; detail: string };
  "human.requested": { requestIds: string[]; kinds: HumanRequestKind[] };
  "human.resolved": { requestIds: string[]; decisions: string[] };
  "synthesis.started": { reason: SynthesisReason; completed: number; gaps: number };
  "run.completed": {
    status: "complete" | "partial";
    durationMs: number;
    usage: Usage;
    tier: Tier | null;
    model: string | null;
    synthesisUsage: Usage | null;
    counts: TaskCounts;
  };
  "run.failed": { error: string };
  /** `unavailableToolServers`: MCP servers this agent references that could not be used for this dispatch. */
  "agent.started": { dispatchId: string; tier: Tier; model: string; unavailableToolServers?: string[] };
  "agent.finished": { dispatchId: string; outcomeStatus: OutcomeStatus | null; error: string | null; durationMs: number };
  "agent.model.started": { dispatchId: string; model: string; callIndex: number };
  "agent.model.finished": {
    dispatchId: string;
    model: string;
    callIndex: number;
    durationMs: number;
    usage: Usage;
    toolCalls: string[];
  };
  "agent.tool.started": { dispatchId: string; tool: string; callId: string | null; args: string };
  "agent.tool.finished": {
    dispatchId: string;
    tool: string;
    callId: string | null;
    ok: boolean;
    durationMs: number;
    preview: string;
  };
  "agent.skill.loaded": { dispatchId: string; skill: string };
  "agent.thought": { dispatchId: string; text: string };
  "evaluation.started": { dispatchId: string; mode: "rules" | "llm" };
  heartbeat: { dispatchId: string; elapsedMs: number };
};

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compile-time guard: every event type has a payload definition and vice versa. */
export const EVENT_DATA_MAP_IS_EXHAUSTIVE: Exact<EventType, keyof EventDataMap> = true;

/** Runtime schema of the envelope (payload validated by producers, not at the state boundary). */
export const LifecycleEventSchema = z.object({
  id: z.string(),
  seq: z.number().int().nullable(),
  ts: z.string(),
  durability: z.enum(["durable", "ephemeral"]),
  type: z.enum(EVENT_TYPES),
  runId: z.string().nullable(),
  threadId: z.string().nullable(),
  planVersion: z.number().int(),
  wave: z.number().int().nullable(),
  taskId: z.string().nullable(),
  dispatchId: z.string().nullable(),
  agentId: z.string().nullable(),
  attempt: z.number().int().nullable(),
  trace: TraceRef.nullable(),
  data: z.any(),
});
export type StoredLifecycleEvent = z.infer<typeof LifecycleEventSchema>;

export type EventEnvelope = Omit<StoredLifecycleEvent, "type" | "data">;
export type LifecycleEventOf<T extends EventType> = EventEnvelope & { type: T; data: EventDataMap[T] };
/** Discriminated union over every event type — switch on `type` to narrow `data`. */
export type LifecycleEvent = { [K in EventType]: LifecycleEventOf<K> }[EventType];

const DURABLE_SET: ReadonlySet<string> = new Set(DURABLE_EVENT_TYPES);
export const isDurableEventType = (type: string): type is DurableEventType => DURABLE_SET.has(type);

export function isEventOfType<T extends EventType>(
  event: LifecycleEvent,
  type: T,
): event is Extract<LifecycleEvent, { type: T }> {
  return event.type === type;
}

/** Shape of every chunk Analytax writes to the LangGraph custom stream. */
export type CustomStreamChunk = { channel: typeof EVENT_CHANNEL; event: LifecycleEvent };

export function isCustomStreamChunk(value: unknown): value is CustomStreamChunk {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { channel?: unknown; event?: unknown };
  return candidate.channel === EVENT_CHANNEL && typeof candidate.event === "object" && candidate.event !== null;
}
