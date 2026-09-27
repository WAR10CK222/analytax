import {
  EVENT_CHANNEL,
  type CustomStreamChunk,
  type DurableEventType,
  type EventDataMap,
  type LifecycleEvent,
  type RunMeta,
  type TraceRef,
} from "@analytax/contracts";
import type { EphemeralEmit } from "../agents/sessions.js";

export type EventScope = {
  taskId?: string | null;
  dispatchId?: string | null;
  agentId?: string | null;
  attempt?: number | null;
  wave?: number | null;
};

export type EnvelopeBase = {
  runId: string | null;
  threadId: string | null;
  planVersion: number;
  trace: TraceRef | null;
};

export function traceRefFromTraceparent(traceparent: string | null): TraceRef | null {
  const match = traceparent ? /^00-([0-9a-f]{32})-([0-9a-f]{16})-/.exec(traceparent) : null;
  return match?.[1] && match[2] ? { traceId: match[1], spanId: match[2] } : null;
}

export const traceRefFromRun = (run: RunMeta): TraceRef | null => traceRefFromTraceparent(run.traceparent);

/** Collects durable events for one control-node update with a thread-wide monotonic `seq`. */
export class DurableEvents {
  readonly events: LifecycleEvent[] = [];
  private seq: number;
  private planVersion: number;

  constructor(
    startSeq: number,
    private readonly base: EnvelopeBase,
    private readonly now: () => string,
  ) {
    this.seq = startSeq;
    this.planVersion = base.planVersion;
  }

  get lastSeq(): number {
    return this.seq;
  }

  setPlanVersion(version: number): void {
    this.planVersion = version;
  }

  emit<T extends DurableEventType>(type: T, data: EventDataMap[T], scope: EventScope = {}): void {
    this.seq += 1;
    this.events.push({
      id: `d${this.seq}`,
      seq: this.seq,
      ts: this.now(),
      durability: "durable",
      type,
      runId: this.base.runId,
      threadId: this.base.threadId,
      planVersion: this.planVersion,
      wave: scope.wave ?? null,
      taskId: scope.taskId ?? null,
      dispatchId: scope.dispatchId ?? null,
      agentId: scope.agentId ?? null,
      attempt: scope.attempt ?? null,
      trace: this.base.trace,
      data,
    } as LifecycleEvent);
  }
}

/** Ephemeral events from inside a running worker, written to the LangGraph custom stream. */
export function createEphemeralEmitter(args: {
  writer: ((chunk: unknown) => void) | undefined;
  base: EnvelopeBase;
  scope: Required<EventScope> & { dispatchId: string };
  now: () => string;
}): EphemeralEmit {
  let counter = 0;
  return (type, data) => {
    if (!args.writer) return;
    counter += 1;
    const event = {
      id: `${args.scope.dispatchId}:e${counter}`,
      seq: null,
      ts: args.now(),
      durability: "ephemeral",
      type,
      runId: args.base.runId,
      threadId: args.base.threadId,
      planVersion: args.base.planVersion,
      wave: args.scope.wave,
      taskId: args.scope.taskId,
      dispatchId: args.scope.dispatchId,
      agentId: args.scope.agentId,
      attempt: args.scope.attempt,
      trace: args.base.trace,
      data: { ...data, dispatchId: args.scope.dispatchId },
    } as unknown as LifecycleEvent;
    try {
      args.writer({ channel: EVENT_CHANNEL, event } satisfies CustomStreamChunk);
    } catch {
      // Streaming is best-effort; never fail a task because a client disconnected.
    }
  };
}
