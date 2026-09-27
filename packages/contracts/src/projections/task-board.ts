import { TASK_STATUSES, type TaskStatus, type Tier } from "../common.js";
import type { LifecycleEvent } from "../events.js";
import type { TaskPreview } from "../task.js";
import type { Projection } from "./fold.js";

export type TaskCard = TaskPreview & {
  attempt: number;
  tier: Tier | null;
  model: string | null;
  score: number | null;
  summary: string | null;
  statusReason: string | null;
  lastEventType: LifecycleEvent["type"];
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type TaskBoardView = {
  planVersion: number;
  order: string[];
  cards: Record<string, TaskCard>;
};

type CardPatch = Partial<Omit<TaskCard, "id">>;

function patchCard(view: TaskBoardView, event: LifecycleEvent, patch: CardPatch, taskId = event.taskId): TaskBoardView {
  if (!taskId) return view;
  const card = view.cards[taskId];
  if (!card) return view;
  return {
    ...view,
    cards: { ...view.cards, [taskId]: { ...card, ...patch, lastEventType: event.type, updatedAt: event.ts } },
  };
}

function upsertPreviews(view: TaskBoardView, event: LifecycleEvent, previews: readonly TaskPreview[]): TaskBoardView {
  if (previews.length === 0) return view;
  const cards = { ...view.cards };
  const order = [...view.order];
  for (const preview of previews) {
    const existing = cards[preview.id];
    if (existing) {
      cards[preview.id] = { ...existing, ...preview, lastEventType: event.type, updatedAt: event.ts };
      continue;
    }
    cards[preview.id] = {
      ...preview,
      attempt: 0,
      tier: null,
      model: null,
      score: null,
      summary: null,
      statusReason: null,
      lastEventType: event.type,
      createdAt: event.ts,
      updatedAt: event.ts,
      startedAt: null,
      finishedAt: null,
    };
    order.push(preview.id);
  }
  return { ...view, cards, order };
}

export const taskBoardProjection: Projection<TaskBoardView> = {
  name: "taskBoard",
  init: () => ({ planVersion: 0, order: [], cards: {} }),
  apply(view, event) {
    switch (event.type) {
      case "plan.created":
        return { ...upsertPreviews(view, event, event.data.tasks), planVersion: event.data.version };
      case "plan.patched": {
        const { diff } = event.data;
        let next = upsertPreviews(view, event, [...diff.added, ...diff.updated]);
        for (const rewire of diff.rewired) next = patchCard(next, event, { dependsOn: rewire.dependsOn }, rewire.taskId);
        for (const taskId of diff.canceled) {
          next = patchCard(next, event, { status: "canceled", statusReason: "superseded", finishedAt: event.ts }, taskId);
        }
        return { ...next, planVersion: event.data.version };
      }
      case "task.dispatched":
        return patchCard(view, event, {
          status: "working",
          attempt: event.data.attempt,
          tier: event.data.tier,
          model: event.data.model,
          agentId: event.data.agentId,
          statusReason: null,
          startedAt: event.ts,
          finishedAt: null,
        });
      case "task.completed":
        return patchCard(view, event, {
          status: "completed",
          score: event.data.score,
          summary: event.data.summary,
          statusReason: event.data.degraded ? "degraded" : null,
          finishedAt: event.ts,
        });
      case "task.requeued":
      case "task.retried":
      case "task.blocked":
        return patchCard(view, event, { status: "submitted", statusReason: reasonOf(event) });
      case "task.escalated":
        return patchCard(view, event, { status: "submitted", tier: event.data.toTier, statusReason: event.data.reason });
      case "task.reassigned":
        return patchCard(view, event, { status: "submitted", agentId: event.data.toAgentId, statusReason: event.data.reason });
      case "task.input_required":
        return patchCard(view, event, { status: "input-required", statusReason: event.data.questions.join(" · ") });
      case "task.canceled":
        return patchCard(view, event, { status: "canceled", statusReason: event.data.reason, finishedAt: event.ts });
      case "task.failed":
        return patchCard(view, event, { status: "failed", statusReason: event.data.reason, finishedAt: event.ts });
      case "task.rejected":
        return patchCard(view, event, { status: "rejected", statusReason: event.data.reason, finishedAt: event.ts });
      default:
        return view;
    }
  },
};

function reasonOf(event: LifecycleEvent): string | null {
  switch (event.type) {
    case "task.requeued":
    case "task.blocked":
      return event.data.reason;
    case "task.retried":
      return event.data.feedback || "retry";
    default:
      return null;
  }
}

export function boardColumns(view: TaskBoardView): Record<TaskStatus, TaskCard[]> {
  const columns = Object.fromEntries(TASK_STATUSES.map((status) => [status, [] as TaskCard[]])) as Record<
    TaskStatus,
    TaskCard[]
  >;
  for (const id of view.order) {
    const card = view.cards[id];
    if (card) columns[card.status].push(card);
  }
  return columns;
}

/** A submitted task whose dependencies are not all completed yet. */
export function isWaiting(view: TaskBoardView, card: TaskCard): boolean {
  return card.status === "submitted" && card.dependsOn.some((dep) => view.cards[dep]?.status !== "completed");
}
