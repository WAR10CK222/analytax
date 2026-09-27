import { defaultProjections, emptyUsage, foldEvents, type EventDataMap, type EventType, type LifecycleEvent, type TaskPreview } from "@analytax/contracts";

let seq = 0;

export function resetSeq(): void {
  seq = 0;
}

export function durable<T extends EventType>(type: T, data: EventDataMap[T], extra: Partial<LifecycleEvent> = {}): LifecycleEvent {
  seq += 1;
  return {
    id: `d${seq}`,
    seq,
    ts: new Date(Date.UTC(2026, 8, 22, 12, 0, seq)).toISOString(),
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

export function ephemeral<T extends EventType>(type: T, data: EventDataMap[T], extra: Partial<LifecycleEvent> = {}): LifecycleEvent {
  const event = durable(type, data, extra);
  return { ...event, id: `e${event.seq}`, seq: null, durability: "ephemeral" } as LifecycleEvent;
}

export const preview = (id: string, dependsOn: string[] = [], overrides: Partial<TaskPreview> = {}): TaskPreview => ({
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
  ...overrides,
});

export const fold = (events: LifecycleEvent[]) => foldEvents(events, defaultProjections);

/** A run that plans three tasks, blocks on a prerequisite, retries the writer, and completes partially. */
export function adaptiveRun(): LifecycleEvent[] {
  resetSeq();
  const hitl = { clarify: true, approvePlan: false, humanReview: false };
  return [
    durable("run.started", { query: "Compare A and B", hitl, maxConcurrency: 4, deadlineAt: null, faultsEnabled: false }),
    durable("plan.created", {
      version: 1,
      path: "plan",
      rationale: "research then write",
      tasks: [preview("t1"), preview("t2", ["t1"], { agentId: "writer", title: "Write brief" })],
      tier: "deep",
      model: "m",
      usage: emptyUsage(),
    }),
    durable("wave.started", { wave: 1, dispatchIds: ["t1.a1.w1"] }, { wave: 1 }),
    durable("task.dispatched", { dispatchId: "t1.a1.w1", attempt: 1, tier: "standard", agentId: "researcher", model: "m", packetTokens: 100 }, { taskId: "t1", agentId: "researcher", wave: 1 }),
    durable(
      "plan.patched",
      {
        version: 2,
        source: "policy",
        reason: "prerequisite needed",
        ops: [{ op: "add_task", taskId: "t3", reason: "prereq" }],
        diff: { added: [preview("t3", [], { title: "Find data" })], updated: [], canceled: [], rewired: [{ taskId: "t1", dependsOn: ["t3"] }] },
      },
      { planVersion: 2, wave: 1 },
    ),
    durable("task.blocked", { dispatchId: "t1.a1.w1", prerequisiteTaskId: "t3", reason: "needs data" }, { taskId: "t1", agentId: "researcher", wave: 1 }),
    durable("wave.completed", { wave: 1, reports: 1, durationMs: 1000, progress: false, stallCount: 1 }, { wave: 1 }),
    durable("task.retried", { dispatchId: "t2.a1.w3", nextAttempt: 2, feedback: "Fix these problems: Missing required sections: Recommendation" }, { taskId: "t2", agentId: "writer", wave: 3 }),
    durable("guard.tripped", { guard: "stall", detail: "no task accepted in 3 waves, forcing a replan" }),
    durable("run.completed", {
      status: "partial",
      durationMs: 5000,
      usage: emptyUsage(),
      tier: "standard",
      model: "m",
      synthesisUsage: emptyUsage(),
      counts: { total: 3, completed: 1, failed: 0, canceled: 0, rejected: 0 },
    }),
  ];
}
