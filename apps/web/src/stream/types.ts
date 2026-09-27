import type {
  ControlState,
  FinalAnswer,
  HitlInterrupt,
  IntentAnalysis,
  LifecycleEvent,
  OrchestrationViews,
  PlanMeta,
  RunContext,
  RunInput,
  RunMeta,
  Task,
  TaskResult,
  WorkerReport,
} from "@analytax/contracts";

/** A serialized LangChain message as it appears in `values.messages`. */
export type SerializedMessage = {
  id?: string;
  type?: string;
  content?: unknown;
  [key: string]: unknown;
};

/**
 * Orchestrator graph state as streamed in `values`. Every key is optional: before hydration (and while a
 * fresh thread is being created) the SDKs expose `{}` or partial optimistic values.
 */
export type OrchestratorValues = {
  messages?: SerializedMessage[];
  runOptions?: RunContext | null;
  input?: RunInput | null;
  run?: RunMeta;
  intent?: IntentAnalysis | null;
  plan?: PlanMeta;
  tasks?: Record<string, Task>;
  results?: Record<string, TaskResult>;
  inbox?: Record<string, WorkerReport>;
  control?: ControlState;
  events?: LifecycleEvent[];
  final?: FinalAnswer | null;
};

/** Per-run options submitted with the first message (`input.runOptions`). */
export type RunOptionsInput = RunContext;

export type PendingInterrupt = {
  /** Protocol interrupt id; used to target `respond`. */
  readonly id: string | undefined;
  readonly value: HitlInterrupt;
};

export type OrchestratorStreamOptions = {
  apiUrl: string;
  assistantId: string;
  /** Thread to rejoin on mount (from `?thread=`). */
  initialThreadId: string | null;
  /** `catalog.guards.recursionLimit`; sent as `config.recursion_limit` on every run and resume. */
  recursionLimit: number | undefined;
  /** Fires when the bound thread changes (new thread created, or reset to null). */
  onThreadId?: (threadId: string | null) => void;
};

export type OrchestratorStream = {
  /** Which SDK adapter is active. */
  readonly sdk: "react" | "legacy";
  readonly threadId: string | null;
  readonly values: OrchestratorValues;
  /** Read models folded from durable + live events. */
  readonly views: OrchestrationViews;
  /** Buffered ephemeral events (oldest first). */
  readonly liveEvents: readonly LifecycleEvent[];
  /** Validated HITL interrupts awaiting a response. */
  readonly interrupts: readonly PendingInterrupt[];
  readonly isLoading: boolean;
  readonly isThreadLoading: boolean;
  /** Server-side thread status from the last poll (null until known); tells a stopped run from a running one. */
  readonly threadStatus: "idle" | "busy" | "interrupted" | "error" | null;
  readonly error: unknown;
  /** Starts a run on a brand-new thread. */
  start(query: string, runOptions: RunOptionsInput): Promise<void>;
  /** Resumes the pending interrupt (or the one with `interruptId`). */
  respond(value: unknown, interruptId?: string): Promise<void>;
  /** Cancels the active run. */
  stop(): Promise<void>;
  /** Detaches from the current thread and clears all state. */
  reset(): void;
};
