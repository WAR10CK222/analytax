import { RunContext } from "@analytax/contracts";
import type { BaseCheckpointSaver, BaseStore } from "@langchain/langgraph";
import { END, START, StateGraph, isGraphInterrupt, type RetryPolicy } from "@langchain/langgraph";
import type { Guards } from "../config/schema.js";
import { classifyError } from "../util/errors.js";
import type { OrchestratorDeps } from "./deps.js";
import { createApprovePlanNode, createClarifyNode, createHumanReviewNode } from "./nodes/hitl.js";
import { createIntakeNode } from "./nodes/intake.js";
import { createPlanNode } from "./nodes/plan.js";
import { createReconcileNode } from "./nodes/reconcile.js";
import { createReplanNode } from "./nodes/replan.js";
import { createSynthesizeNode } from "./nodes/synthesize.js";
import { createWorkerNode } from "./nodes/worker.js";
import { routeAfterIntake, routeAfterPlan, routeAfterReconcile } from "./routing.js";
import { OrchestratorState } from "./state.js";

/** Sized so our own wave/replan guards always fire before LangGraph's GraphRecursionError. */
export const computeRecursionLimit = (guards: Guards): number =>
  8 + 2 * guards.maxWaves + 2 * (guards.maxReplans + guards.maxHumanReviews + guards.maxClarifyRounds) + 20;

const transientRetry: RetryPolicy = {
  maxAttempts: 3,
  initialInterval: 1_000,
  backoffFactor: 2,
  jitter: true,
  retryOn: (error) => !isGraphInterrupt(error) && classifyError(error).transient,
};

export function buildOrchestratorGraph(deps: OrchestratorDeps) {
  return new StateGraph(OrchestratorState, RunContext)
    .addNode("intake", createIntakeNode(deps), { retryPolicy: transientRetry })
    .addNode("clarify", createClarifyNode(deps))
    // Node names must not collide with state keys (`plan` is a channel), hence "planner".
    .addNode("planner", createPlanNode(deps), { retryPolicy: transientRetry })
    .addNode("approvePlan", createApprovePlanNode(deps), { ends: ["reconcile", "planner", "approvePlan"] })
    .addNode("reconcile", createReconcileNode(deps), { retryPolicy: { maxAttempts: 2, retryOn: (error) => !isGraphInterrupt(error) } })
    .addNode("worker", createWorkerNode(deps), { retryPolicy: { maxAttempts: 2, retryOn: (error) => !isGraphInterrupt(error) } })
    .addNode("replan", createReplanNode(deps), { retryPolicy: transientRetry })
    .addNode("humanReview", createHumanReviewNode(deps))
    .addNode("synthesize", createSynthesizeNode(deps), { retryPolicy: transientRetry })
    .addEdge(START, "intake")
    .addConditionalEdges("intake", routeAfterIntake(deps), ["clarify", "planner"])
    .addEdge("clarify", "intake")
    .addConditionalEdges("planner", routeAfterPlan, ["approvePlan", "reconcile"])
    .addConditionalEdges("reconcile", routeAfterReconcile(deps), ["worker", "replan", "humanReview", "synthesize"])
    .addEdge("worker", "reconcile")
    .addEdge("replan", "reconcile")
    .addEdge("humanReview", "reconcile")
    .addEdge("synthesize", END);
}

export function compileOrchestrator(deps: OrchestratorDeps, options: { checkpointer?: BaseCheckpointSaver; store?: BaseStore } = {}) {
  return buildOrchestratorGraph(deps)
    .compile({ ...options, name: "analytax" })
    .withConfig({ recursionLimit: computeRecursionLimit(deps.config.orchestrator.guards) });
}
