import type { EventDataMap, GuardName, LifecycleEvent, PlanDiff } from "@analytax/contracts";
import { TIER_LABEL, humanizeKey, type StatusFamily } from "../lib/status";

export type AdaptationKind =
  | "proposal"
  | "prerequisite"
  | "retry"
  | "escalation"
  | "reassignment"
  | "replan"
  | "guard"
  | "plan_edit"
  | "plan_rejected"
  | "human_decision"
  | "patch";

export type Adaptation = {
  id: string;
  ts: string;
  wave: number | null;
  kind: AdaptationKind;
  family: StatusFamily;
  title: string;
  detail: string | null;
  taskIds: string[];
  planVersion: number | null;
  diff: { added: number; updated: number; canceled: number; rewired: number } | null;
};

const GUARD_LABEL: Partial<Record<GuardName, string>> = {
  stall: "No progress for several waves",
  auto_spawn_frozen: "Stopped adding new tasks automatically",
};

const firstLine = (text: string, max = 280): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

const diffCounts = (diff: PlanDiff) => ({ added: diff.added.length, updated: diff.updated.length, canceled: diff.canceled.length, rewired: diff.rewired.length });

type Patched = LifecycleEvent & { type: "plan.patched"; data: EventDataMap["plan.patched"] };

/**
 * Plain-language story of how the plan adapted, oldest first. Pairs plan patches with the decision that caused them
 * (emit order in the orchestrator: plan.patched, then proposal.accepted / plan.approved / replan.completed).
 */
export function narrateAdaptations(events: readonly LifecycleEvent[], title: (taskId: string) => string): Adaptation[] {
  const out: Adaptation[] = [];
  const consumed = new Set<string>();
  const patches: Patched[] = [];

  const base = (event: LifecycleEvent) => ({ id: event.id, ts: event.ts, wave: event.wave, planVersion: event.planVersion });
  const quoted = (id: string) => `"${title(id)}"`;

  const takePatch = (predicate: (patch: Patched) => boolean): Patched | null => {
    for (let index = patches.length - 1; index >= 0; index -= 1) {
      const patch = patches[index]!;
      if (!consumed.has(patch.id) && predicate(patch)) {
        consumed.add(patch.id);
        return patch;
      }
    }
    return null;
  };

  for (const event of events) {
    if (event.durability !== "durable") continue;
    switch (event.type) {
      case "plan.patched":
        patches.push(event as Patched);
        break;
      case "proposal.accepted": {
        const patch = takePatch((candidate) => candidate.data.source === "proposal" && candidate.data.diff.added.some((task) => task.id === event.data.newTaskId));
        const reviser = event.data.kind === "follow_up" ? "follow-up" : humanizeKey(event.data.kind).toLowerCase();
        out.push({
          ...base(event),
          kind: "proposal",
          family: "neutral",
          title: `${title(event.data.fromTaskId)} suggested a ${reviser}: "${event.data.title}"`,
          detail: patch?.data.reason ? firstLine(patch.data.reason) : null,
          taskIds: [event.data.fromTaskId, event.data.newTaskId],
          diff: patch ? diffCounts(patch.data.diff) : null,
        });
        break;
      }
      case "task.blocked": {
        const taskId = event.taskId;
        const prerequisite = event.data.prerequisiteTaskId;
        const patch = prerequisite ? takePatch((candidate) => candidate.data.diff.added.some((task) => task.id === prerequisite)) : null;
        out.push({
          ...base(event),
          kind: "prerequisite",
          family: "attention",
          title: prerequisite
            ? `${taskId ? quoted(taskId) : "A task"} was blocked, so ${quoted(prerequisite)} was added first`
            : `${taskId ? quoted(taskId) : "A task"} was blocked`,
          detail: firstLine(event.data.reason),
          taskIds: [taskId, prerequisite].filter((id): id is string => Boolean(id)),
          diff: patch ? diffCounts(patch.data.diff) : null,
        });
        break;
      }
      case "task.retried":
        out.push({
          ...base(event),
          kind: "retry",
          family: "attention",
          title: `Retried ${event.taskId ? quoted(event.taskId) : "a task"} with review feedback`,
          detail: firstLine(event.data.feedback.replace(/^Fix these problems:\s*/i, "")),
          taskIds: event.taskId ? [event.taskId] : [],
          diff: null,
        });
        break;
      case "task.escalated":
        out.push({
          ...base(event),
          kind: "escalation",
          family: "attention",
          title: `Moved ${event.taskId ? quoted(event.taskId) : "a task"} from the ${TIER_LABEL[event.data.fromTier]} to the ${TIER_LABEL[event.data.toTier]} tier`,
          detail: firstLine(event.data.reason),
          taskIds: event.taskId ? [event.taskId] : [],
          diff: null,
        });
        break;
      case "task.reassigned":
        out.push({
          ...base(event),
          kind: "reassignment",
          family: "neutral",
          title: `Reassigned ${event.taskId ? quoted(event.taskId) : "a task"} from ${event.data.fromAgentId} to ${event.data.toAgentId}`,
          detail: firstLine(event.data.reason),
          taskIds: event.taskId ? [event.taskId] : [],
          diff: null,
        });
        break;
      case "replan.completed": {
        const patch = takePatch((candidate) => candidate.data.source === "replanner");
        out.push({
          ...base(event),
          kind: "replan",
          family: "attention",
          title: event.data.fallback ? "Could not revise the plan, so stuck tasks were stopped" : "Revised the plan",
          detail: event.data.diagnosis ? firstLine(event.data.diagnosis, 360) : null,
          taskIds: patch ? [...patch.data.diff.added.map((task) => task.id), ...patch.data.diff.canceled] : [],
          diff: patch ? diffCounts(patch.data.diff) : null,
        });
        break;
      }
      case "plan.approved":
        if (event.data.edited) {
          const patch = takePatch((candidate) => candidate.data.source === "human");
          out.push({
            ...base(event),
            kind: "plan_edit",
            family: "neutral",
            title: "You edited the plan before it ran",
            detail: patch ? patch.data.ops.map((op) => (op.taskId ? `${humanizeKey(op.op)} ${title(op.taskId)}` : humanizeKey(op.op))).join(", ") : null,
            taskIds: patch ? patch.data.ops.map((op) => op.taskId).filter((id): id is string => Boolean(id)) : [],
            diff: patch ? diffCounts(patch.data.diff) : null,
          });
        }
        break;
      case "plan.rejected":
        out.push({
          ...base(event),
          kind: "plan_rejected",
          family: "neutral",
          title: "You asked for a different plan",
          detail: firstLine(event.data.feedback),
          taskIds: [],
          diff: null,
        });
        break;
      case "human.resolved":
        out.push({
          ...base(event),
          kind: "human_decision",
          family: "neutral",
          title: "You answered a question from the run",
          detail: event.data.decisions.map((decision) => humanizeKey(decision.replace(/^[^:]+:\s*/, ""))).join(", ") || null,
          taskIds: [],
          diff: null,
        });
        break;
      case "guard.tripped":
        out.push({
          ...base(event),
          kind: "guard",
          family: "attention",
          title: GUARD_LABEL[event.data.guard] ?? `Safety limit reached: ${humanizeKey(event.data.guard).toLowerCase()}`,
          detail: firstLine(event.data.detail),
          taskIds: [],
          diff: null,
        });
        break;
      default:
        break;
    }
  }

  // Patches no decision claimed (e.g. automatic rewiring after an upstream failure) narrate on their own.
  for (const patch of patches) {
    if (consumed.has(patch.id) || patch.data.source === "planner") continue;
    out.push({
      ...base(patch),
      kind: "patch",
      family: "neutral",
      title: patch.data.source === "policy" ? "Adjusted the plan automatically" : "Updated the plan",
      detail: patch.data.reason ? firstLine(patch.data.reason) : null,
      taskIds: [...patch.data.diff.added.map((task) => task.id), ...patch.data.diff.canceled],
      diff: diffCounts(patch.data.diff),
    });
  }

  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}
