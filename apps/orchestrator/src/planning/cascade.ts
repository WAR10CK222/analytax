import type { Task } from "@analytax/contracts";
import { dependentsIndex, hasCriticalDescendant, sortedTasks, type TaskMap } from "./dag.js";
import { BROKEN_STATUSES, MUTABLE_STATUSES } from "./readiness.js";

export interface CascadeOptions {
  now: string;
  /** Whether the replanner may still be invoked this run. */
  replanAvailable: boolean;
  /** Failed tasks with a queued replan/human request — leave their dependents alone until it's handled. */
  heldTaskIds: ReadonlySet<string>;
  /** Failed tasks that already triggered an upstream_failed replan — don't wait for another. */
  upstreamReplanned: ReadonlySet<string>;
}

export interface CascadeResult {
  changed: Record<string, Task>;
  tasks: Record<string, Task>;
  canceled: { taskId: string; cascadeFrom: string; reason: string }[];
  dropped: { taskId: string; dependency: string }[];
  rewired: { taskId: string; from: string; to: string }[];
  /** Failed tasks whose critical dependents should be rescued by the replanner. */
  replanFor: { failedTaskId: string; dependentIds: string[] }[];
}

/**
 * Propagates upstream failures to submitted dependents (idempotent sweep):
 * best_effort → drop the dependency with a note; critical path → ask the replanner once; otherwise cancel and recurse.
 */
export function cascadeFailures(base: TaskMap, options: CascadeOptions): CascadeResult {
  const tasks: Record<string, Task> = { ...base };
  const changed: Record<string, Task> = {};
  const canceled: CascadeResult["canceled"] = [];
  const dropped: CascadeResult["dropped"] = [];
  const rewired: CascadeResult["rewired"] = [];
  const replanFor = new Map<string, string[]>();

  const update = (task: Task, patch: Partial<Task>): void => {
    const next = { ...task, ...patch, updatedAt: options.now };
    tasks[task.id] = next;
    changed[task.id] = next;
  };

  let progressed = true;
  while (progressed) {
    progressed = false;
    const index = dependentsIndex(tasks);
    for (const failed of sortedTasks(tasks)) {
      if (!BROKEN_STATUSES.has(failed.status)) continue;
      if (failed.status === "canceled" && failed.supersededBy.length > 0) continue;
      if (options.heldTaskIds.has(failed.id)) continue;

      for (const dependentId of index.get(failed.id) ?? []) {
        const dependent = tasks[dependentId];
        if (!dependent || !MUTABLE_STATUSES.has(dependent.status) || !dependent.dependsOn.includes(failed.id)) continue;

        // A failed revision falls back to its completed original.
        const original = failed.revisionOf ? tasks[failed.revisionOf] : undefined;
        if (original?.status === "completed") {
          update(dependent, {
            dependsOn: [...new Set(dependent.dependsOn.map((id) => (id === failed.id ? original.id : id)))],
            contextFrom: [...new Set(dependent.contextFrom.map((id) => (id === failed.id ? original.id : id)))],
            notes: [...dependent.notes, `Revision ${failed.id} did not complete; using the original result of ${original.id}.`],
          });
          rewired.push({ taskId: dependent.id, from: failed.id, to: original.id });
          progressed = true;
          continue;
        }

        // Optional work (non-critical proposals, best_effort dependents) never cancels the main path.
        if (dependent.dependencyPolicy === "best_effort" || (failed.origin.kind === "proposal" && !failed.critical)) {
          update(dependent, {
            dependsOn: dependent.dependsOn.filter((id) => id !== failed.id),
            notes: [
              ...dependent.notes,
              `Dependency ${failed.id} ("${failed.title}") did not complete (${failed.status}${
                failed.statusReason ? `: ${failed.statusReason}` : ""
              }). Proceed with the inputs that are available and say what is missing.`,
            ],
          });
          dropped.push({ taskId: dependent.id, dependency: failed.id });
          progressed = true;
          continue;
        }

        const onCriticalPath = dependent.critical || hasCriticalDescendant(tasks, dependent.id, index);
        if (onCriticalPath && options.replanAvailable && !options.upstreamReplanned.has(failed.id)) {
          const list = replanFor.get(failed.id) ?? [];
          if (!list.includes(dependent.id)) list.push(dependent.id);
          replanFor.set(failed.id, list);
          continue;
        }
        if (replanFor.has(failed.id)) continue;

        const reason = `upstream_failed:${failed.id}`;
        update(dependent, { status: "canceled", statusReason: reason, activeDispatchId: null });
        canceled.push({ taskId: dependent.id, cascadeFrom: failed.id, reason });
        progressed = true;
      }
    }
  }

  return {
    changed,
    tasks,
    canceled,
    dropped,
    rewired,
    replanFor: [...replanFor.entries()].map(([failedTaskId, dependentIds]) => ({ failedTaskId, dependentIds })),
  };
}
