import type { AttemptRecord, EventDataMap, LifecycleEvent, Task } from "@analytax/contracts";

export type Evaluation = EventDataMap["evaluation.completed"] & { ts: string };

export type AttemptView = {
  attempt: number;
  dispatchId: string;
  records: AttemptRecord[];
  evaluation: Evaluation | null;
};

/**
 * One row per dispatch of a task (newest first), joining the task's attempt history with the evaluator's verdict
 * events by dispatch id. Evaluations of dispatches that no longer appear in the bounded history are kept too.
 */
export function mergeAttempts(task: Task | undefined, events: readonly LifecycleEvent[] | undefined, taskId: string): AttemptView[] {
  const byDispatch = new Map<string, AttemptView>();
  const order: string[] = [];
  const ensure = (dispatchId: string, attempt: number): AttemptView => {
    let view = byDispatch.get(dispatchId);
    if (!view) {
      view = { attempt, dispatchId, records: [], evaluation: null };
      byDispatch.set(dispatchId, view);
      order.push(dispatchId);
    }
    return view;
  };

  for (const event of events ?? []) {
    if (event.type !== "evaluation.completed" || event.taskId !== taskId) continue;
    ensure(event.data.dispatchId, event.data.attempt).evaluation = { ...event.data, ts: event.ts };
  }
  for (const record of task?.history ?? []) ensure(record.dispatchId, record.attempt).records.push(record);

  return order
    .map((id) => byDispatch.get(id)!)
    .sort((a, b) => b.attempt - a.attempt || (b.evaluation?.ts ?? "").localeCompare(a.evaluation?.ts ?? ""));
}
