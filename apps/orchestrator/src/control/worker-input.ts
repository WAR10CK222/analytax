import type { DemoFault, DispatchRecord, Task } from "@analytax/contracts";
import type { ContextPacket } from "./context-packet.js";

/** Payload of each `Send("worker", …)`. Plain data only: it is checkpointed with the pending send. */
export type WorkerInput = {
  dispatch: DispatchRecord;
  task: Task;
  packet: ContextPacket;
  run: {
    runId: string | null;
    threadId: string | null;
    traceparent: string | null;
    planVersion: number;
    deadlineAt: string | null;
    faultsEnabled: boolean;
    /** MCP servers this run turned off (optional: sends checkpointed before MCP support lack it). */
    toolServersOff?: string[];
  };
  faults: DemoFault[];
  /** No other task consumes this result — it feeds the final answer directly. */
  isSink: boolean;
};
