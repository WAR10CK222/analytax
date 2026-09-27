import { Send } from "@langchain/langgraph";
import { buildContextPacket } from "../control/context-packet.js";
import type { WorkerInput } from "../control/worker-input.js";
import { dependentsIndex } from "../planning/dag.js";
import type { OrchestratorDeps } from "./deps.js";
import type { State } from "./state.js";

export const routeAfterIntake =
  (deps: OrchestratorDeps) =>
  (state: State): "clarify" | "planner" => {
    const intent = state.intent;
    const hitl = state.run.hitl ?? deps.config.orchestrator.hitl;
    const wantsClarification = Boolean(intent?.ambiguity.isAmbiguous && intent.ambiguity.questions.length > 0);
    return wantsClarification && hitl.clarify && state.control.clarifyRounds < deps.config.orchestrator.guards.maxClarifyRounds
      ? "clarify"
      : "planner";
  };

export const routeAfterPlan = (state: State): "approvePlan" | "reconcile" => (state.plan.approved ? "reconcile" : "approvePlan");

export function buildWorkerInput(state: State, dispatchId: string, deps: OrchestratorDeps): WorkerInput {
  const dispatch = state.control.dispatches[dispatchId];
  const task = dispatch ? state.tasks[dispatch.taskId] : undefined;
  if (!dispatch || !task) throw new Error(`Dispatch ${dispatchId} has no matching task`);
  const resolved = deps.models.resolve(dispatch.tier);
  const packet = buildContextPacket(task, { tasks: state.tasks, results: state.results, intent: state.intent, input: state.input }, resolved.contextTokens);
  const dependents = dependentsIndex(state.tasks).get(task.id) ?? [];
  return {
    dispatch,
    task,
    packet,
    run: {
      runId: state.run.runId,
      threadId: state.run.threadId,
      traceparent: state.run.traceparent,
      planVersion: state.plan.version,
      deadlineAt: state.control.deadlineAt,
      faultsEnabled: state.run.faultsEnabled,
      toolServersOff: (state.run.toolServers ?? []).filter((server) => server.status === "off").map((server) => server.id),
    },
    faults: state.run.faultsEnabled ? (state.runOptions?.demoFaults ?? []) : [],
    isSink: !dependents.some((id) => state.tasks[id]?.status !== "canceled"),
  };
}

/** Reconcile already decided (and recorded) the route; this edge only materializes it — Send fan-out for workers. */
export const routeAfterReconcile =
  (deps: OrchestratorDeps) =>
  (state: State): Send[] | "replan" | "humanReview" | "synthesize" => {
    const route = state.control.route;
    switch (route?.kind) {
      case "dispatch":
        return route.dispatchIds.map((id) => new Send("worker", buildWorkerInput(state, id, deps)));
      case "replan":
        return "replan";
      case "human_review":
        return "humanReview";
      default:
        return "synthesize";
    }
  };
