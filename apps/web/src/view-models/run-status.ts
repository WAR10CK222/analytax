import type { LedgerView, RunPhase } from "@analytax/contracts";
import { tone, type Tone } from "../lib/status";

export type RunStatus = "starting" | "running" | "needs_input" | "completed" | "partial" | "failed" | "stopped" | "idle";

export type ThreadStatus = "idle" | "busy" | "interrupted" | "error" | null;

export const RUN_STATUS_TONE: Readonly<Record<RunStatus, Tone>> = {
  starting: tone("Starting", "running"),
  running: tone("Running", "running"),
  needs_input: tone("Needs your input", "attention"),
  completed: tone("Completed", "success"),
  partial: tone("Partial answer", "attention", "partial"),
  failed: tone("Failed", "danger"),
  stopped: tone("Stopped", "neutral", "stopped"),
  idle: tone("Not started", "neutral"),
};

const ACTIVE_PHASES: ReadonlySet<RunPhase> = new Set(["analyzing", "planning", "executing", "awaiting_human", "synthesizing"]);

export const isActiveStatus = (status: RunStatus): boolean => status === "starting" || status === "running" || status === "needs_input";

/**
 * One status for the whole run, from the event ledger plus what the page knows (interrupts, streaming, thread poll).
 * A run cancelled mid-way never emits `run.completed`, so an active ledger phase with nothing running is "stopped".
 */
export function deriveRunStatus(input: {
  phase: RunPhase;
  finalStatus: LedgerView["finalStatus"];
  pendingInterrupts: number;
  isLoading: boolean;
  threadStatus: ThreadStatus;
  starting: boolean;
}): RunStatus {
  const { phase, finalStatus, pendingInterrupts, isLoading, threadStatus, starting } = input;
  if (phase === "failed") return "failed";
  if (phase === "completed") return finalStatus === "partial" ? "partial" : "completed";
  if (pendingInterrupts > 0) return "needs_input";
  if (phase === "idle") return starting || isLoading ? "starting" : "idle";
  if (ACTIVE_PHASES.has(phase) && !isLoading && (threadStatus === "idle" || threadStatus === "error")) return "stopped";
  return "running";
}
