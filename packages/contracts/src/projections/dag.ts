import type { LifecycleEvent } from "../events.js";
import type { OpSourceKind } from "../plan-ops.js";
import type { Projection } from "./fold.js";
import type { TaskBoardView, TaskCard } from "./task-board.js";

export type PlanVersionEntry = {
  version: number;
  ts: string;
  source: OpSourceKind;
  reason: string;
  added: string[];
  updated: string[];
  canceled: string[];
  rewired: string[];
};

export type DagView = {
  version: number;
  history: PlanVersionEntry[];
};

export const dagProjection: Projection<DagView> = {
  name: "dag",
  init: () => ({ version: 0, history: [] }),
  apply(view, event: LifecycleEvent) {
    switch (event.type) {
      case "plan.created":
        return {
          version: event.data.version,
          history: [
            ...view.history,
            {
              version: event.data.version,
              ts: event.ts,
              source: "planner",
              reason: event.data.rationale,
              added: event.data.tasks.map((task) => task.id),
              updated: [],
              canceled: [],
              rewired: [],
            },
          ],
        };
      case "plan.patched": {
        const { diff } = event.data;
        return {
          version: event.data.version,
          history: [
            ...view.history,
            {
              version: event.data.version,
              ts: event.ts,
              source: event.data.source,
              reason: event.data.reason,
              added: diff.added.map((task) => task.id),
              updated: diff.updated.map((task) => task.id),
              canceled: diff.canceled,
              rewired: diff.rewired.map((rewire) => rewire.taskId),
            },
          ],
        };
      }
      default:
        return view;
    }
  },
};

export type DagEdgeState = "satisfied" | "pending" | "broken";
export type DagEdge = { id: string; source: string; target: string; state: DagEdgeState };
export type DagGraph = { nodes: TaskCard[]; edges: DagEdge[]; lastChange: PlanVersionEntry | null };

const BROKEN = new Set(["failed", "canceled", "rejected"]);

/** Nodes/edges for rendering: edges point from a dependency (source) to its dependent (target). */
export function selectDagGraph(board: TaskBoardView, dag: DagView): DagGraph {
  const nodes = board.order.map((id) => board.cards[id]).filter((card): card is TaskCard => card !== undefined);
  const edges: DagEdge[] = [];
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      const source = board.cards[dependency];
      if (!source) continue;
      const state: DagEdgeState =
        source.status === "completed" ? "satisfied" : BROKEN.has(source.status) ? "broken" : "pending";
      edges.push({ id: `${dependency}->${node.id}`, source: dependency, target: node.id, state });
    }
  }
  return { nodes, edges, lastChange: dag.history.at(-1) ?? null };
}
