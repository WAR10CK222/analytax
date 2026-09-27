import { isWaiting, type Task, type TaskBoardView, type TaskCard, type TaskStatus } from "@analytax/contracts";
import { SUPERSEDED_TONE, taskTone, type Tone } from "../lib/status";
import type { RunStatus } from "./run-status";

export type Lane = "todo" | "in_progress" | "done" | "not_finished";

export const LANE_LABEL: Readonly<Record<Lane, string>> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  not_finished: "Didn't finish",
};

export const LANES: readonly Lane[] = ["todo", "in_progress", "done", "not_finished"];

export function laneOf(status: TaskStatus): Lane {
  switch (status) {
    case "submitted":
      return "todo";
    case "working":
    case "input-required":
      return "in_progress";
    case "completed":
      return "done";
    default:
      return "not_finished";
  }
}

export function isSuperseded(card: TaskCard, task?: Task): boolean {
  return (task?.supersededBy.length ?? 0) > 0 || card.statusReason === "superseded";
}

/** Status tone for a card: replaced > waiting > raw status. A task still "working" on a stopped run reads "Stopped". */
export function cardTone(board: TaskBoardView, card: TaskCard, task: Task | undefined, run: RunStatus | null = null): Tone {
  if (isSuperseded(card, task)) return SUPERSEDED_TONE;
  if (run === "stopped" && card.status === "working") return { ...taskTone("canceled"), label: "Stopped", icon: "stopped" };
  return taskTone(card.status, isWaiting(board, card));
}

export function orderedCards(board: TaskBoardView): TaskCard[] {
  return board.order.map((id) => board.cards[id]).filter((card): card is TaskCard => card !== undefined);
}

export function groupByLane(board: TaskBoardView): Record<Lane, TaskCard[]> {
  const lanes: Record<Lane, TaskCard[]> = { todo: [], in_progress: [], done: [], not_finished: [] };
  for (const card of orderedCards(board)) lanes[laneOf(card.status)].push(card);
  return lanes;
}

export type OverviewGroupId = "in_progress" | "up_next" | "done" | "not_finished" | "replaced";

export type OverviewGroup = { id: OverviewGroupId; label: string; cards: TaskCard[]; defaultOpen: boolean };

/** Task list for the Overview tab, grouped by what the reader cares about. Empty groups are omitted. */
export function overviewGroups(board: TaskBoardView, tasks: Record<string, Task> | undefined, run: RunStatus): OverviewGroup[] {
  const groups: Record<OverviewGroupId, TaskCard[]> = { in_progress: [], up_next: [], done: [], not_finished: [], replaced: [] };
  for (const card of orderedCards(board)) {
    if (isSuperseded(card, tasks?.[card.id])) groups.replaced.push(card);
    else if (card.status === "working" || card.status === "input-required") groups.in_progress.push(card);
    else if (card.status === "submitted") groups.up_next.push(card);
    else if (card.status === "completed") groups.done.push(card);
    else groups.not_finished.push(card);
  }
  const finished = run === "completed" || run === "partial" || run === "failed" || run === "stopped";
  const spec: { id: OverviewGroupId; label: string; defaultOpen: boolean }[] = [
    { id: "in_progress", label: run === "stopped" ? "Interrupted" : "In progress", defaultOpen: true },
    { id: "up_next", label: finished ? "Not started" : "Up next", defaultOpen: !finished },
    { id: "not_finished", label: "Didn't finish", defaultOpen: true },
    { id: "done", label: "Done", defaultOpen: !finished && groups.in_progress.length === 0 },
    { id: "replaced", label: "Replaced or removed", defaultOpen: false },
  ];
  return spec.filter((group) => groups[group.id].length > 0).map((group) => ({ ...group, cards: groups[group.id] }));
}

/** "4 of 6 tasks": canceled and replaced tasks are not work the run still has to do. */
export function taskCounts(board: TaskBoardView, tasks?: Record<string, Task>): { done: number; total: number; failed: number; active: number } {
  let done = 0;
  let total = 0;
  let failed = 0;
  let active = 0;
  for (const card of orderedCards(board)) {
    if (card.status === "canceled" || isSuperseded(card, tasks?.[card.id])) continue;
    total += 1;
    if (card.status === "completed") done += 1;
    else if (card.status === "failed" || card.status === "rejected") failed += 1;
    else if (card.status === "working" || card.status === "input-required") active += 1;
  }
  return { done, total, failed, active };
}

export function pendingDependencies(board: TaskBoardView, card: TaskCard): string[] {
  return card.dependsOn.filter((id) => board.cards[id]?.status !== "completed");
}

export function taskTitle(board: TaskBoardView, id: string): string {
  return board.cards[id]?.title ?? id;
}
