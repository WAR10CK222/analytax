import { isTerminalStatus, type Task, type TaskStatus } from "@analytax/contracts";
import { sortedTasks, type TaskMap } from "./dag.js";

export const BROKEN_STATUSES: ReadonlySet<TaskStatus> = new Set(["failed", "canceled", "rejected"]);
export const MUTABLE_STATUSES: ReadonlySet<TaskStatus> = new Set(["submitted", "input-required"]);

export const isReady = (task: Task, tasks: TaskMap): boolean =>
  task.status === "submitted" && task.dependsOn.every((dependency) => tasks[dependency]?.status === "completed");

export const readyTasks = (tasks: TaskMap): Task[] => sortedTasks(tasks).filter((task) => isReady(task, tasks));

export const selectDispatches = (tasks: TaskMap, limit: number): Task[] => readyTasks(tasks).slice(0, Math.max(0, limit));

export const allTerminal = (tasks: TaskMap): boolean =>
  Object.values(tasks).length > 0 && Object.values(tasks).every((task) => isTerminalStatus(task.status));

export const workingTasks = (tasks: TaskMap): Task[] => sortedTasks(tasks).filter((task) => task.status === "working");

/** Non-terminal tasks that cannot currently make progress (not ready, not running, not awaiting a human). */
export const stuckTasks = (tasks: TaskMap): Task[] =>
  sortedTasks(tasks).filter((task) => task.status === "submitted" && !isReady(task, tasks));

export type TaskCounts = { total: number; completed: number; failed: number; canceled: number; rejected: number };

export function countTasks(tasks: TaskMap): TaskCounts {
  const counts: TaskCounts = { total: 0, completed: 0, failed: 0, canceled: 0, rejected: 0 };
  for (const task of Object.values(tasks)) {
    if (task.status === "canceled" && task.supersededBy.length > 0) continue;
    counts.total++;
    if (task.status === "completed") counts.completed++;
    else if (task.status === "failed") counts.failed++;
    else if (task.status === "canceled") counts.canceled++;
    else if (task.status === "rejected") counts.rejected++;
  }
  return counts;
}
