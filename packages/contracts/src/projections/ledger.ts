import type { GuardName, HitlSettings, RunToolServer } from "../control.js";
import type { LifecycleEvent } from "../events.js";
import type { Projection } from "./fold.js";

export type RunPhase =
  | "idle"
  | "analyzing"
  | "planning"
  | "executing"
  | "awaiting_human"
  | "synthesizing"
  | "completed"
  | "failed";

export type LedgerView = {
  phase: RunPhase;
  runId: string | null;
  query: string | null;
  startedAt: string | null;
  wave: number;
  stallCount: number;
  replans: number;
  replanRequests: number;
  humanRequests: number;
  autoSpawnFrozen: boolean;
  guards: { guard: GuardName; detail: string; ts: string }[];
  hitl: HitlSettings | null;
  maxConcurrency: number | null;
  deadlineAt: string | null;
  /** MCP tool servers as they stood when the run started; null for runs from before MCP support. */
  toolServers: RunToolServer[] | null;
  finalStatus: "complete" | "partial" | null;
  error: string | null;
};

export const ledgerProjection: Projection<LedgerView> = {
  name: "ledger",
  init: () => ({
    phase: "idle",
    runId: null,
    query: null,
    startedAt: null,
    wave: 0,
    stallCount: 0,
    replans: 0,
    replanRequests: 0,
    humanRequests: 0,
    autoSpawnFrozen: false,
    guards: [],
    hitl: null,
    maxConcurrency: null,
    deadlineAt: null,
    toolServers: null,
    finalStatus: null,
    error: null,
  }),
  apply(view, event: LifecycleEvent) {
    switch (event.type) {
      case "run.started":
        return {
          ...view,
          phase: "analyzing",
          runId: event.runId,
          query: event.data.query,
          startedAt: event.ts,
          hitl: event.data.hitl,
          maxConcurrency: event.data.maxConcurrency,
          deadlineAt: event.data.deadlineAt,
          toolServers: event.data.toolServers ?? null,
        };
      case "intent.analyzed":
      case "plan.rejected":
        return { ...view, phase: "planning" };
      case "plan.created":
      case "plan.approved":
      case "replan.completed":
      case "human.resolved":
        return {
          ...view,
          phase: "executing",
          replans: event.type === "replan.completed" ? view.replans + 1 : view.replans,
        };
      case "wave.started":
        return { ...view, phase: "executing", wave: event.data.wave };
      case "wave.completed":
        return { ...view, stallCount: event.data.stallCount };
      case "replan.requested":
        return { ...view, replanRequests: view.replanRequests + 1 };
      case "human.requested":
        return { ...view, phase: "awaiting_human", humanRequests: view.humanRequests + 1 };
      case "guard.tripped":
        return {
          ...view,
          autoSpawnFrozen: view.autoSpawnFrozen || event.data.guard === "auto_spawn_frozen",
          guards: [...view.guards, { guard: event.data.guard, detail: event.data.detail, ts: event.ts }],
        };
      case "synthesis.started":
        return { ...view, phase: "synthesizing" };
      case "run.completed":
        return { ...view, phase: "completed", finalStatus: event.data.status };
      case "run.failed":
        return { ...view, phase: "failed", error: event.data.error };
      default:
        return view;
    }
  },
};
