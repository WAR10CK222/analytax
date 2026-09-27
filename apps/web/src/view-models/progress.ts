import type { HitlInterrupt, RunPhase } from "@analytax/contracts";
import type { RunStatus } from "./run-status";

export type StepId = "understand" | "plan" | "execute" | "answer";
export type StepState = "done" | "current" | "waiting" | "upcoming" | "failed" | "stopped" | "partial";

export type ProgressStep = { id: StepId; label: string; state: StepState; detail: string | null };

const STEPS: readonly { id: StepId; label: string }[] = [
  { id: "understand", label: "Understand" },
  { id: "plan", label: "Plan" },
  { id: "execute", label: "Execute" },
  { id: "answer", label: "Answer" },
];

const INTERRUPT_STEP: Record<HitlInterrupt["kind"], StepId> = { clarify: "understand", approve_plan: "plan", human_review: "execute" };

/** Index of the step the run is at (or last reached), or -1 before anything happened. */
function reachedIndex(input: {
  phase: RunPhase;
  interruptKind: HitlInterrupt["kind"] | null;
  hasIntent: boolean;
  tasks: { done: number; total: number };
  wave: number;
  hasFinal: boolean;
}): number {
  const { phase, interruptKind, hasIntent, tasks, wave, hasFinal } = input;
  if (hasFinal || phase === "completed" || phase === "synthesizing") return 3;
  if (interruptKind) return STEPS.findIndex((step) => step.id === INTERRUPT_STEP[interruptKind]);
  if (phase === "executing" || wave > 0) return 2;
  if (phase === "planning" || tasks.total > 0) return 1;
  if (phase === "analyzing" || hasIntent) return 0;
  return -1;
}

/** The four-step rail: finished steps, where the run is now, and what's next. */
export function deriveProgress(input: {
  phase: RunPhase;
  status: RunStatus;
  interruptKind: HitlInterrupt["kind"] | null;
  hasIntent: boolean;
  tasks: { done: number; total: number };
  wave: number;
  hasFinal: boolean;
}): { steps: ProgressStep[]; executeRatio: number | null } {
  const { status, tasks } = input;
  const reached = status === "starting" ? 0 : reachedIndex(input);
  const finished = status === "completed" || status === "partial";
  const executeRatio = tasks.total > 0 ? Math.min(1, tasks.done / tasks.total) : null;

  const steps = STEPS.map((step, index): ProgressStep => {
    let state: StepState;
    // A partial answer means some tasks never finished, so Execute is not shown as done.
    if (finished) state = status === "partial" && step.id === "execute" && tasks.done < tasks.total ? "partial" : "done";
    else if (index < reached) state = "done";
    else if (index > reached) state = "upcoming";
    else if (status === "needs_input") state = "waiting";
    else if (status === "failed") state = "failed";
    else if (status === "stopped") state = "stopped";
    else state = "current";

    let detail: string | null = null;
    if (state === "waiting") detail = "Waiting for you";
    else if (state === "failed") detail = "Failed here";
    else if (state === "stopped") detail = "Stopped here";
    if (step.id === "execute" && tasks.total > 0 && state !== "upcoming") {
      const count = `${tasks.done} of ${tasks.total} tasks`;
      detail = detail && state !== "done" ? `${count}, ${detail.toLowerCase()}` : count;
    }
    return { id: step.id, label: step.label, state, detail };
  });

  return { steps, executeRatio };
}
