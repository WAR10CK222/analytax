import {
  addUsage,
  emptyUsage,
  isTerminalStatus,
  type PlanPatchWire,
  type ReplanRequest,
  type Task,
  type Tier,
} from "@analytax/contracts";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { DurableEvents, traceRefFromRun } from "../../control/events.js";
import { describeCardTools } from "../../mcp/directory.js";
import { applyPlanOps, type ApplyResult } from "../../planning/apply-plan-ops.js";
import { sortedTasks } from "../../planning/dag.js";
import { countTasks, isReady } from "../../planning/readiness.js";
import { proposePatch, renderDetailedOutline } from "../../roles/prompts.js";
import { planPatchToOps } from "../../roles/wire.js";
import { callbacksFor } from "../../telemetry/genai-handler.js";
import { recordDurableEvents } from "../../telemetry/metrics.js";
import { withSpan } from "../../telemetry/tracing.js";
import { truncate } from "../../util/text.js";
import type { OrchestratorDeps } from "../deps.js";
import type { State, Update } from "../state.js";

/** Deterministic fallback when the replanner gives up or can't produce a valid patch. */
function fallback(state: State, requests: readonly ReplanRequest[], now: string): { changed: Record<string, Task>; canceled: Task[]; failed: Task[] } {
  const changed: Record<string, Task> = {};
  const canceled: Task[] = [];
  const failed: Task[] = [];
  if (!requests.some((request) => request.trigger === "deadlock" || request.trigger === "stall")) return { changed, canceled, failed };
  for (const task of sortedTasks(state.tasks)) {
    if (isTerminalStatus(task.status) || task.status === "working") continue;
    if (task.status === "submitted" && isReady(task, state.tasks)) continue;
    const next: Task = task.critical
      ? { ...task, status: "failed", statusReason: "unresolvable dependencies (replanner could not fix)", updatedAt: now }
      : { ...task, status: "canceled", statusReason: "stuck (replanner could not fix)", updatedAt: now };
    changed[task.id] = next;
    (next.status === "failed" ? failed : canceled).push(next);
  }
  return { changed, canceled, failed };
}

export function createReplanNode(deps: OrchestratorDeps) {
  return async (state: State, config: LangGraphRunnableConfig): Promise<Update> => {
    const requests = state.control.queues.replan;
    if (requests.length === 0) return {};
    const now = deps.clock.now().toISOString();
    const { guards } = deps.config.orchestrator;

    return withSpan(
      "orchestrator.replan",
      { parent: state.run.traceparent, attributes: { "analytax.node": "replan", "analytax.replan.requests": requests.length } },
      async (span, spanContext) => {
        const directory = deps.agents.directoryPrompt(
          (name) => deps.skills.get(name)?.description,
          (card) => describeCardTools(card, state.run.toolServers),
        );
        const outline = renderDetailedOutline(state.tasks, state.results);
        const counts = countTasks(state.tasks);
        let usage = emptyUsage();
        let tier: Tier | null = null;
        let model: string | null = null;
        let errors: string[] = [];
        let previous: PlanPatchWire | null = null;
        let applied: ApplyResult | null = null;
        let diagnosis = "";

        for (let round = 0; round < 3 && !applied; round++) {
          const result = await proposePatch(deps.structured, {
            query: state.input?.query ?? "",
            goal: state.intent?.goal ?? "",
            outline,
            requests,
            directory,
            tasksRemaining: Math.max(0, guards.maxTotalTasks - counts.total),
            replansRemaining: guards.maxReplans - state.control.replans,
            previous,
            errors,
            callbacks: callbacksFor(config, spanContext, { "analytax.role": "replanner" }),
            signal: config.signal,
          });
          usage = addUsage(usage, result.usage);
          tier = result.tier;
          model = result.model;
          previous = result.value;
          diagnosis = result.value.diagnosis;
          if (result.value.giveUp) break;
          const mapped = planPatchToOps(result.value, { kind: "replanner", taskId: null });
          if (mapped.errors.length > 0) {
            errors = mapped.errors;
            continue;
          }
          if (mapped.ops.length === 0) {
            errors = ["the patch contains no operations — return at least one operation or set giveUp=true"];
            continue;
          }
          const attempt = applyPlanOps(
            state.tasks,
            mapped.ops,
            {
              agents: deps.agents,
              guards,
              now,
              planVersion: state.plan.version,
              taskSeq: state.control.taskSeq,
              spentFingerprints: state.control.spentFingerprints,
            },
            "atomic",
          );
          if (!attempt.ok) {
            errors = attempt.errors;
            continue;
          }
          applied = attempt;
        }

        const control = structuredClone(state.control);
        let planVersion = state.plan.version;
        let tasks: Record<string, Task> = {};
        const events = new DurableEvents(
          control.eventSeq,
          { runId: state.run.runId, threadId: state.run.threadId, planVersion, trace: traceRefFromRun(state.run) },
          () => now,
        );

        if (applied) {
          tasks = applied.changed;
          planVersion = applied.planVersion;
          control.taskSeq = applied.taskSeq;
          control.spentFingerprints = applied.spentFingerprints;
          events.setPlanVersion(planVersion);
          events.emit("plan.patched", {
            version: planVersion,
            source: "replanner",
            reason: truncate(diagnosis, 400),
            ops: applied.applied.map(({ op, taskIds }) => ({
              op: op.op,
              taskId: "taskId" in op ? op.taskId : (taskIds[0] ?? null),
              reason: truncate(op.reason, 200),
            })),
            diff: applied.diff,
          });
        } else {
          const result = fallback(state, requests, now);
          tasks = result.changed;
          for (const task of result.canceled) events.emit("task.canceled", { reason: task.statusReason ?? "stuck", cascadeFrom: null }, { taskId: task.id, agentId: task.agentId });
          for (const task of result.failed) events.emit("task.failed", { dispatchId: null, reason: task.statusReason ?? "stuck", degraded: false }, { taskId: task.id, agentId: task.agentId });
        }

        events.emit("replan.completed", {
          requestIds: requests.map((request) => request.id),
          diagnosis: truncate(diagnosis, 600),
          applied: applied?.applied.length ?? 0,
          rejected: errors.length,
          fallback: !applied,
          tier,
          model,
          usage,
        });
        control.replans += 1;
        control.queues.replan = [];
        control.usage = addUsage(control.usage, usage);
        control.eventSeq = events.lastSeq;
        span.setAttributes({ "analytax.replan.applied": applied?.applied.length ?? 0, "analytax.replan.fallback": !applied });
        recordDurableEvents(events.events);

        return {
          tasks,
          control,
          events: events.events,
          ...(planVersion !== state.plan.version ? { plan: { ...state.plan, version: planVersion } } : {}),
        };
      },
    );
  };
}
