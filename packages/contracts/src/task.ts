import { z } from "zod";
import { ArtifactRef, Complexity, Source, TaskStatus, Tier } from "./common.js";

export const MACHINE_CHECK_KINDS = [
  "minWords",
  "maxWords",
  "contains",
  "sections",
  "minSources",
  "minFindings",
] as const;

/** Deterministic acceptance checks issued by the planner. `sections` uses `|` to separate headings. */
export const MachineCheck = z.object({
  kind: z.enum(MACHINE_CHECK_KINDS),
  value: z.string(),
});
export type MachineCheck = z.infer<typeof MachineCheck>;

export const DependencyPolicy = z.enum(["all", "best_effort"]);
export type DependencyPolicy = z.infer<typeof DependencyPolicy>;

export const EvaluationMode = z.enum(["auto", "always", "never"]);
export type EvaluationMode = z.infer<typeof EvaluationMode>;

export const TaskOriginKind = z.enum([
  "plan",
  "direct",
  "fallback",
  "proposal",
  "replan",
  "human",
  "split",
  "revision",
]);
export type TaskOriginKind = z.infer<typeof TaskOriginKind>;

export const TaskOrigin = z.object({
  kind: TaskOriginKind,
  parentTaskId: z.string().nullable(),
  planVersion: z.number().int(),
  depth: z.number().int().nonnegative(),
});
export type TaskOrigin = z.infer<typeof TaskOrigin>;

export const AttemptDecision = z.enum([
  "accepted",
  "retried",
  "escalated",
  "reassigned",
  "requeued",
  "blocked",
  "input_required",
  "failed",
  "rejected",
  "replan_requested",
  "human_requested",
  "discarded",
]);
export type AttemptDecision = z.infer<typeof AttemptDecision>;

export const AttemptRecord = z.object({
  attempt: z.number().int(),
  dispatchId: z.string(),
  agentId: z.string(),
  tier: Tier,
  outcomeStatus: z.string().nullable(),
  decision: AttemptDecision,
  score: z.number().nullable(),
  feedback: z.string(),
  issues: z.array(z.string()),
  errorSignature: z.string().nullable(),
  outputFingerprint: z.string().nullable(),
  at: z.string(),
});
export type AttemptRecord = z.infer<typeof AttemptRecord>;

/** A task definition before it is committed to the ledger (ids/refs in `dependsOn` are resolved on commit). */
export const NewTask = z.object({
  title: z.string().min(1),
  instructions: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  checks: z.array(MachineCheck).default([]),
  capability: z.string().min(1),
  agentId: z.string().min(1),
  complexity: Complexity,
  tierOverride: Tier.nullable().default(null),
  dependsOn: z.array(z.string()).default([]),
  dependencyPolicy: DependencyPolicy.default("all"),
  contextFrom: z.array(z.string()).default([]),
  critical: z.boolean().default(false),
  evaluation: EvaluationMode.default("auto"),
});
export type NewTask = z.infer<typeof NewTask>;
export type NewTaskInput = z.input<typeof NewTask>;

export const Task = NewTask.extend({
  id: z.string(),
  status: TaskStatus,
  statusReason: z.string().nullable(),
  origin: TaskOrigin,
  fingerprint: z.string(),
  /** Semantic attempts dispatched so far (infra requeues don't count). */
  attempt: z.number().int().nonnegative(),
  infraRetries: z.number().int().nonnegative(),
  blockCount: z.number().int().nonnegative(),
  triedAgents: z.array(z.string()),
  currentTier: Tier.nullable(),
  activeDispatchId: z.string().nullable(),
  /** Most recent attempts (bounded). */
  history: z.array(AttemptRecord),
  notes: z.array(z.string()),
  /** Evaluator feedback to hand to the next attempt. */
  pendingFeedback: z.string().nullable(),
  /** Next attempt should proceed on stated assumptions instead of asking for input. */
  assumeOnRetry: z.boolean(),
  partialRef: ArtifactRef.nullable(),
  supersededBy: z.array(z.string()),
  revisionOf: z.string().nullable(),
  revisions: z.number().int().nonnegative(),
  staleInputs: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof Task>;

export const TaskResult = z.object({
  taskId: z.string(),
  agentId: z.string(),
  tier: Tier,
  attempt: z.number().int(),
  dispatchId: z.string(),
  summary: z.string(),
  keyFindings: z.array(z.string()),
  sources: z.array(Source),
  assumptions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  confidence: z.number(),
  /** Inline output when small; otherwise `outputRef` points to the artifact store. */
  output: z.string().nullable(),
  outputRef: ArtifactRef.nullable(),
  outputChars: z.number().int().nonnegative(),
  score: z.number().nullable(),
  evaluatedBy: z.enum(["rules", "llm", "skipped"]),
  degraded: z.boolean(),
  completedAt: z.string(),
});
export type TaskResult = z.infer<typeof TaskResult>;

/** Compact, UI-safe view of a task carried inside lifecycle events and interrupts. */
export const TaskPreview = z.object({
  id: z.string(),
  title: z.string(),
  instructions: z.string(),
  acceptanceCriteria: z.array(z.string()),
  agentId: z.string(),
  capability: z.string(),
  complexity: Complexity,
  dependsOn: z.array(z.string()),
  critical: z.boolean(),
  status: TaskStatus,
  originKind: TaskOriginKind,
  parentTaskId: z.string().nullable(),
  revisionOf: z.string().nullable(),
});
export type TaskPreview = z.infer<typeof TaskPreview>;

export const toTaskPreview = (task: Task): TaskPreview => ({
  id: task.id,
  title: task.title,
  instructions: task.instructions,
  acceptanceCriteria: task.acceptanceCriteria,
  agentId: task.agentId,
  capability: task.capability,
  complexity: task.complexity,
  dependsOn: task.dependsOn,
  critical: task.critical,
  status: task.status,
  originKind: task.origin.kind,
  parentTaskId: task.origin.parentTaskId,
  revisionOf: task.revisionOf,
});
