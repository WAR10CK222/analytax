import { z } from "zod";
import { ArtifactRef, ModelUsage, Tier, TraceRef, Usage } from "./common.js";
import { TaskOutcome } from "./outcome.js";
import { IssueSeverity, Verdict } from "./verdict.js";

export const WorkerErrorKind = z.enum(["timeout", "model", "tool", "schema", "limit", "aborted", "unknown"]);
export type WorkerErrorKind = z.infer<typeof WorkerErrorKind>;

export const WorkerError = z.object({
  kind: WorkerErrorKind,
  transient: z.boolean(),
  /** Stable signature used for loop detection (kind + normalized message). */
  signature: z.string(),
  message: z.string(),
});
export type WorkerError = z.infer<typeof WorkerError>;

export const CheckResult = z.object({
  id: z.string(),
  passed: z.boolean(),
  severity: IssueSeverity,
  message: z.string(),
});
export type CheckResult = z.infer<typeof CheckResult>;

/** The only thing a parallel worker writes: its report, keyed by dispatch id. */
export const WorkerReport = z.object({
  dispatchId: z.string(),
  taskId: z.string(),
  attempt: z.number().int(),
  wave: z.number().int(),
  agentId: z.string(),
  tier: Tier,
  model: z.string(),
  outcome: TaskOutcome.nullable(),
  /** Full output persisted to the artifact store when large. */
  outputRef: ArtifactRef.nullable(),
  error: WorkerError.nullable(),
  checks: z.array(CheckResult),
  verdict: Verdict.nullable(),
  outputFingerprint: z.string().nullable(),
  /** Agent plus judge usage. */
  usage: Usage,
  /** The judge call on its own (a different model than the agent), when one ran. */
  judge: ModelUsage.nullable().optional(),
  startedAt: z.string(),
  durationMs: z.number().nonnegative(),
  trace: TraceRef.nullable(),
});
export type WorkerReport = z.infer<typeof WorkerReport>;
