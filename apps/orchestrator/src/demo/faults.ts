import type { DemoFault, TaskOutcome } from "@analytax/contracts";
import type { WorkerInput } from "../control/worker-input.js";

/**
 * Showcase-only fault injection. Makes the adaptive paths (prerequisite discovery, rejections, transient errors,
 * follow-ups, reassignment) reliably demoable without waiting for a model to misbehave.
 */
export function matchFault(input: WorkerInput): DemoFault | null {
  if (!input.run.faultsEnabled) return null;
  const { task, dispatch } = input;
  return (
    input.faults.find((fault) => {
      if (fault.agentId && fault.agentId !== dispatch.agentId) return false;
      if (fault.taskTitleIncludes && !task.title.toLowerCase().includes(fault.taskTitleIncludes.toLowerCase())) return false;
      switch (fault.kind) {
        case "block_with_prerequisite":
          return task.blockCount < fault.times;
        case "transient_error":
          return task.infraRetries < fault.times;
        case "decline":
          return task.triedAgents.length <= fault.times;
        default:
          return dispatch.attempt <= fault.times;
      }
    }) ?? null
  );
}

export class InjectedTransientError extends Error {
  override name = "InjectedTransientError";
  readonly statusCode = 503;
}

export function faultOutcome(fault: DemoFault, input: WorkerInput): TaskOutcome | null {
  const { task } = input;
  const base: TaskOutcome = {
    status: "completed",
    summary: "",
    output: "",
    keyFindings: [],
    sources: [],
    confidence: 0.2,
    assumptions: [],
    openQuestions: [],
    proposals: [],
  };
  switch (fault.kind) {
    case "block_with_prerequisite":
      return {
        ...base,
        status: "blocked",
        summary: `(demo fault) "${task.title}" needs additional data before it can be completed.`,
        output: `Partial notes for "${task.title}": waiting for prerequisite data.`,
        proposals: [
          {
            kind: "prerequisite",
            title: `Gather missing baseline data for ${task.title}`,
            instructions: `Collect the baseline facts and figures that "${task.title}" needs but that no upstream task provided. Return them as a concise, sourced list.`,
            capability: "web_research",
            rationale: "Injected demo fault: prerequisite discovered mid-task",
          },
        ],
      };
    case "decline":
      return {
        ...base,
        status: "declined",
        summary: `(demo fault) ${input.dispatch.agentId} declined "${task.title}" as outside its role.`,
        output: "Declined.",
      };
    case "reject":
      return {
        ...base,
        summary: "(demo fault) Intentionally incomplete draft.",
        output: "(demo fault) This draft intentionally ignores the acceptance criteria so the recovery ladder can be observed.",
      };
    default:
      return null;
  }
}

export const followUpProposal = (input: WorkerInput): TaskOutcome["proposals"][number] => ({
  kind: "follow_up",
  title: `Verify key claims from ${input.task.title}`,
  instructions: `Independently verify the three most important claims made in the result of "${input.task.title}" and report any corrections with sources.`,
  capability: "fact_checking",
  rationale: "Injected demo fault: follow-up work discovered after completion",
});
