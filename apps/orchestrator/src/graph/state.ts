import {
  ControlState,
  FinalAnswer,
  IntentAnalysis,
  LifecycleEventSchema,
  PlanMeta,
  RunContext,
  RunInput,
  RunMeta,
  Task,
  TaskResult,
  WorkerReport,
  emptyPlanMeta,
  emptyRunMeta,
  initialControl,
} from "@analytax/contracts";
import { DeltaValue, MessagesValue, ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

const replace = <T>(_current: T, next: T): T => next;
const mergeByKey = <T>(current: Record<string, T>, next: Record<string, T>): Record<string, T> => ({ ...current, ...next });

/** Workers `put` their report under a unique dispatch id (parallel-safe); reconcile `ack`s processed reports. */
export const InboxUpdate = z.object({
  put: z.record(z.string(), WorkerReport).optional(),
  ack: z.array(z.string()).optional(),
});

export const OrchestratorState = new StateSchema({
  /** The client's query (human message) and the final answer (AI message). */
  messages: MessagesValue,
  /** Per-run options sent by the client with the first message (HITL toggles, concurrency, demo faults). */
  runOptions: new ReducedValue(RunContext.nullable().default(null), { reducer: replace }),
  input: new ReducedValue(RunInput.nullable().default(null), { reducer: replace }),
  run: new ReducedValue(RunMeta.default(emptyRunMeta()), { reducer: replace }),
  intent: new ReducedValue(IntentAnalysis.nullable().default(null), { reducer: replace }),
  plan: new ReducedValue(PlanMeta.default(emptyPlanMeta()), { reducer: replace }),
  /** The task ledger (DAG). Written only by serialized control nodes. */
  tasks: new ReducedValue(z.record(z.string(), Task).default({}), { reducer: mergeByKey }),
  results: new ReducedValue(z.record(z.string(), TaskResult).default({}), { reducer: mergeByKey }),
  inbox: new ReducedValue(z.record(z.string(), WorkerReport).default({}), {
    inputSchema: InboxUpdate,
    reducer: (current, update) => {
      const next = { ...current, ...(update.put ?? {}) };
      for (const id of update.ack ?? []) delete next[id];
      return next;
    },
  }),
  control: new ReducedValue(ControlState.default(initialControl()), { reducer: replace }),
  /** Durable lifecycle events (append-only; delta-checkpointed). */
  events: new DeltaValue(z.array(LifecycleEventSchema).default([]), {
    inputSchema: z.array(LifecycleEventSchema),
    reducer: (current, writes) => (writes.length === 0 ? current : current.concat(...writes)),
  }),
  final: new ReducedValue(FinalAnswer.nullable().default(null), { reducer: replace }),
});

export type State = typeof OrchestratorState.State;
export type Update = typeof OrchestratorState.Update;
