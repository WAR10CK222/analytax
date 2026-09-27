import { describe, expect, it } from "vitest";
import {
  boardColumns,
  defaultProjections,
  emptyUsage,
  foldEvents,
  orderEvents,
  selectDagGraph,
  type EventDataMap,
  type EventType,
  type LifecycleEvent,
  type TaskPreview,
} from "../src/index.js";

let seq = 0;
function durable<T extends EventType>(type: T, data: EventDataMap[T], extra: Partial<LifecycleEvent> = {}): LifecycleEvent {
  seq += 1;
  return {
    id: `d${seq}`,
    seq,
    ts: new Date(Date.UTC(2026, 8, 10, 12, 0, seq)).toISOString(),
    durability: "durable",
    type,
    runId: "run",
    threadId: "thread",
    planVersion: 1,
    wave: null,
    taskId: null,
    dispatchId: null,
    agentId: null,
    attempt: null,
    trace: null,
    data,
    ...extra,
  } as LifecycleEvent;
}

function ephemeral<T extends EventType>(type: T, data: EventDataMap[T], ts: string, id: string, extra: Partial<LifecycleEvent> = {}): LifecycleEvent {
  return { ...durable(type, data, extra), id, seq: null, ts, durability: "ephemeral" } as LifecycleEvent;
}

const preview = (id: string, dependsOn: string[] = []): TaskPreview => ({
  id,
  title: `Task ${id}`,
  instructions: "do it",
  acceptanceCriteria: ["done"],
  agentId: "researcher",
  capability: "web_research",
  complexity: "medium",
  dependsOn,
  critical: false,
  status: "submitted",
  originKind: "plan",
  parentTaskId: null,
  revisionOf: null,
});

function scenario(): LifecycleEvent[] {
  seq = 0;
  const hitl = { clarify: true, approvePlan: false, humanReview: false };
  return [
    durable("run.started", { query: "Compare A and B", hitl, maxConcurrency: 4, deadlineAt: null, faultsEnabled: false }),
    durable("plan.created", { version: 1, path: "plan", rationale: "research then compare", tasks: [preview("t1"), preview("t2", ["t1"])], tier: "deep", model: "m", usage: emptyUsage() }),
    durable("wave.started", { wave: 1, dispatchIds: ["t1.a1.w1"] }),
    durable("task.dispatched", { dispatchId: "t1.a1.w1", attempt: 1, tier: "standard", agentId: "researcher", model: "m", packetTokens: 100 }, { taskId: "t1", agentId: "researcher" }),
    durable("evaluation.completed", {
      dispatchId: "t1.a1.w1", attempt: 1, tier: "standard", model: "m", outcomeStatus: "blocked", decision: null, score: null,
      evaluatedBy: null, unmetCriteria: [], issues: [], error: null, usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 5, modelCalls: 1 }, durationMs: 1000,
    }, { taskId: "t1", agentId: "researcher" }),
    durable("plan.patched", {
      version: 2, source: "policy", reason: "prerequisite", ops: [{ op: "add_task", taskId: "t3", reason: "prereq" }, { op: "add_dependency", taskId: "t1", reason: "wait" }],
      diff: { added: [preview("t3")], updated: [], canceled: [], rewired: [{ taskId: "t1", dependsOn: ["t3"] }] },
    }, { planVersion: 2 }),
    durable("task.blocked", { dispatchId: "t1.a1.w1", prerequisiteTaskId: "t3", reason: "needs data" }, { taskId: "t1", agentId: "researcher" }),
    durable("wave.completed", { wave: 1, reports: 1, durationMs: 1000, progress: false, stallCount: 1 }),
    durable("task.completed", { dispatchId: "t3.a1.w2", attempt: 1, tier: "fast", score: 0.9, evaluatedBy: "llm", summary: "data found", degraded: false }, { taskId: "t3", agentId: "researcher" }),
    durable("guard.tripped", { guard: "stall", detail: "no progress" }),
    durable("synthesis.started", { reason: "partial", completed: 1, gaps: 1 }),
    durable("run.completed", { status: "partial", durationMs: 5000, usage: emptyUsage(), tier: "standard", model: "m", synthesisUsage: emptyUsage(), counts: { total: 3, completed: 1, failed: 0, canceled: 0, rejected: 0 } }),
  ];
}

describe("projections", () => {
  it("orders durable events by seq, merges ephemeral events by time, and dedupes by id", () => {
    const events = scenario();
    const live = ephemeral("agent.started", { dispatchId: "t1.a1.w1", tier: "standard", model: "m" }, events[3]!.ts, "t1.a1.w1:e1", { taskId: "t1", agentId: "researcher" });
    const shuffled = [events[5]!, live, ...events.slice().reverse(), events[0]!];
    const ordered = orderEvents(shuffled);
    expect(ordered.filter((event) => event.durability === "durable").map((event) => event.seq)).toEqual(events.map((event) => event.seq));
    expect(ordered).toHaveLength(events.length + 1);
    expect(ordered.findIndex((event) => event.id === live.id)).toBe(4);
  });

  it("folds a run into board, DAG, metrics, ledger and timeline views", () => {
    const views = foldEvents(scenario(), defaultProjections);

    expect(views.taskBoard.planVersion).toBe(2);
    expect(views.taskBoard.cards.t1).toMatchObject({ status: "submitted", dependsOn: ["t3"], statusReason: "needs data" });
    expect(views.taskBoard.cards.t3?.status).toBe("completed");
    expect(boardColumns(views.taskBoard).completed.map((card) => card.id)).toEqual(["t3"]);

    const graph = selectDagGraph(views.taskBoard, views.dag);
    expect(graph.edges.map((edge) => `${edge.id}:${edge.state}`).sort()).toEqual(["t1->t2:pending", "t3->t1:satisfied"]);
    expect(views.dag.history.map((entry) => entry.version)).toEqual([1, 2]);

    expect(views.metrics.counts).toMatchObject({ dispatched: 1, completed: 1, blocked: 1, planPatches: 1 });
    expect(views.metrics.byTier.standard?.inputTokens).toBe(10);
    expect(views.metrics.guardTrips).toEqual({ stall: 1 });

    expect(views.ledger).toMatchObject({ phase: "completed", finalStatus: "partial", stallCount: 1, wave: 1 });
    expect(views.timeline.entries.some((entry) => entry.title.includes("Plan updated to version 2 by automatic rules"))).toBe(true);
    expect(views.agentActivity.agents.researcher?.completed).toBe(1);
  });
});

describe("metrics", () => {
  it("credits judge usage to the judge model instead of the agent model", () => {
    const usage = (input: number, reasoning: number, calls: number) => ({ ...emptyUsage(), inputTokens: input, reasoningTokens: reasoning, modelCalls: calls });
    const views = foldEvents(
      [
        durable("evaluation.completed", {
          dispatchId: "t1.a1.w1", attempt: 1, tier: "standard", model: "pro", outcomeStatus: "completed", decision: "accept", score: 0.9,
          evaluatedBy: "llm", unmetCriteria: [], issues: [], error: null, usage: usage(300, 80, 3), durationMs: 1000,
          judge: { tier: "fast-thinking", model: "flash", usage: usage(100, 30, 1) },
        }, { taskId: "t1", agentId: "researcher" }),
      ],
      defaultProjections,
    );
    expect(views.metrics.usage).toMatchObject({ inputTokens: 300, reasoningTokens: 80, modelCalls: 3 });
    expect(views.metrics.byModel.pro).toMatchObject({ inputTokens: 200, reasoningTokens: 50, modelCalls: 2 });
    expect(views.metrics.byModel.flash).toMatchObject({ inputTokens: 100, reasoningTokens: 30, modelCalls: 1 });
    expect(views.metrics.byTier["fast-thinking"]?.modelCalls).toBe(1);
  });
});
