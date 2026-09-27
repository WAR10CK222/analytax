import type { ControlState, RunMeta, SynthesisReason, Task } from "@analytax/contracts";
import type { Guards } from "../config/schema.js";
import { sortedTasks, type TaskMap } from "../planning/dag.js";
import { BROKEN_STATUSES } from "../planning/readiness.js";

export type Gap = { taskId: string; title: string; reason: string };

/** Broken tasks that materially reduce the answer (ignores superseded splits, failed optional work, fallen-back revisions). */
export function collectGaps(tasks: TaskMap): Gap[] {
  return sortedTasks(tasks)
    .filter((task) => {
      if (!BROKEN_STATUSES.has(task.status)) return false;
      if (task.status === "canceled" && (task.supersededBy.length > 0 || task.statusReason === "plan_rejected")) return false;
      if (task.revisionOf && tasks[task.revisionOf]?.status === "completed") return false;
      if (task.origin.kind === "proposal" && !task.critical) return false;
      return true;
    })
    .map((task: Task) => ({ taskId: task.id, title: task.title, reason: task.statusReason ?? task.status }));
}

/** Why the run must stop dispatching now, if at all. */
export function stopReason(control: ControlState, run: RunMeta, guards: Guards, now: Date): SynthesisReason | null {
  if (control.abort) return "aborted";
  if (control.deadlineAt && now.getTime() >= Date.parse(control.deadlineAt)) return "deadline";
  if (run.budgetUsd !== null && control.usage.costUsd >= run.budgetUsd) return "budget";
  if (control.wave >= guards.maxWaves) return "max_waves";
  return null;
}
