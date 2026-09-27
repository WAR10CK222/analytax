import {
  addUsage,
  emptyUsage,
  toTaskPreview,
  type IntentAnalysis,
  type PlanDraftWire,
  type PlanOp,
  type Tier,
} from "@analytax/contracts";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { AgentCard, AgentRegistry } from "../../agents/registry.js";
import { DurableEvents, traceRefFromRun } from "../../control/events.js";
import { describeCardTools } from "../../mcp/directory.js";
import { applyPlanOps, type ApplyContext, type ApplyResult } from "../../planning/apply-plan-ops.js";
import { compareTaskIds } from "../../planning/dag.js";
import { draftPlan } from "../../roles/prompts.js";
import { planDraftToOps } from "../../roles/wire.js";
import { callbacksFor } from "../../telemetry/genai-handler.js";
import { recordDurableEvents } from "../../telemetry/metrics.js";
import { withSpan } from "../../telemetry/tracing.js";
import { shortHash, stableStringify } from "../../util/hash.js";
import { shortTitle, truncate } from "../../util/text.js";
import type { OrchestratorDeps } from "../deps.js";
import type { State, Update } from "../state.js";

const complexityOf = (intent: IntentAnalysis) => (intent.complexity === "high" ? "high" : intent.complexity === "medium" ? "medium" : "low");

function singleTaskOps(intent: IntentAnalysis, agent: AgentCard, capability: string, originKind: "direct" | "fallback"): PlanOp[] {
  const constraints = intent.constraints.length ? `\nConstraints: ${intent.constraints.join("; ")}` : "";
  return [
    {
      op: "add_task",
      ref: originKind,
      originKind,
      reason: originKind === "direct" ? "direct path: one agent can answer" : "fallback plan after planning failed",
      source: { kind: "planner", taskId: null },
      task: {
        title: shortTitle(intent.goal, 90),
        instructions: `Answer the client's request (see <client_request>) completely and accurately.\nDeliverable: ${intent.deliverable.format} for ${intent.deliverable.audience} (${intent.deliverable.length}).${constraints}`,
        acceptanceCriteria: [
          "Directly and correctly answers the client's request",
          `Matches the requested deliverable (${intent.deliverable.format}, ${intent.deliverable.length})`,
        ],
        checks: [],
        capability,
        agentId: agent.id,
        complexity: complexityOf(intent),
        tierOverride: null,
        dependsOn: [],
        dependencyPolicy: "all",
        contextFrom: [],
        critical: true,
        evaluation: "auto",
      },
    },
  ];
}

function directAgent(intent: IntentAnalysis, agents: AgentRegistry): { agent: AgentCard; capability: string } {
  const agent = agents.bestFor(intent.suggestedCapability) ?? agents.fallback() ?? agents.list()[0];
  if (!agent) throw new Error("No agents are configured");
  const capability = agent.capabilities.includes(intent.suggestedCapability) ? intent.suggestedCapability : agent.capabilities[0]!;
  return { agent, capability };
}

function fallbackAgent(agents: AgentRegistry): { agent: AgentCard; capability: string } {
  const agent = agents.fallback() ?? agents.list()[0];
  if (!agent) throw new Error("No agents are configured");
  return { agent, capability: agent.capabilities.includes("general_qa") ? "general_qa" : agent.capabilities[0]! };
}

export function createPlanNode(deps: OrchestratorDeps) {
  return async (state: State, config: LangGraphRunnableConfig): Promise<Update> => {
    const intent = state.intent;
    const input = state.input;
    if (!intent || !input) throw new Error("The plan node requires an analyzed intent");
    const intentHash = shortHash(stableStringify({ intent, clarifications: input.clarifications, feedback: state.plan.feedback }));
    if (state.plan.version > 0 && state.plan.intentHash === intentHash) return {};

    const now = deps.clock.now().toISOString();
    const { guards, hitl: defaultHitl } = deps.config.orchestrator;
    const hitl = state.run.hitl ?? defaultHitl;
    const applyContext = (): ApplyContext => ({
      agents: deps.agents,
      guards,
      now,
      planVersion: state.plan.version,
      taskSeq: state.control.taskSeq,
      spentFingerprints: state.control.spentFingerprints,
    });

    return withSpan(
      "plan orchestrator",
      { parent: state.run.traceparent, attributes: { "gen_ai.operation.name": "plan", "gen_ai.agent.name": "orchestrator" } },
      async (span, spanContext) => {
        let usage = emptyUsage();
        let tier: Tier | null = null;
        let model: string | null = null;
        let path: "direct" | "plan" | "fallback" = "plan";
        let rationale = "";
        let guidance = "";
        let applied: ApplyResult | null = null;

        if (intent.path === "direct" || intent.complexity === "trivial") {
          const { agent, capability } = directAgent(intent, deps.agents);
          const result = applyPlanOps(state.tasks, singleTaskOps(intent, agent, capability, "direct"), applyContext(), "atomic");
          if (result.ok) {
            applied = result;
            path = "direct";
            rationale = `A single ${agent.name} task can answer this request directly.`;
          }
        } else {
          let errors: string[] = [];
          let previous: PlanDraftWire | null = null;
          const directory = deps.agents.directoryPrompt(
          (name) => deps.skills.get(name)?.description,
          (card) => describeCardTools(card, state.run.toolServers),
        );
          for (let round = 0; round < 3 && !applied; round++) {
            const result = await draftPlan(deps.structured, {
              query: input.query,
              intent,
              clarifications: input.clarifications,
              directory,
              maxTasks: guards.maxInitialTasks,
              feedback: state.plan.feedback,
              previous,
              errors,
              callbacks: callbacksFor(config, spanContext, { "analytax.role": "planner" }),
              signal: config.signal,
            });
            usage = addUsage(usage, result.usage);
            tier = result.tier;
            model = result.model;
            previous = result.value;
            const mapped = planDraftToOps(result.value, guards.maxInitialTasks);
            if (mapped.errors.length > 0) {
              errors = mapped.errors;
              continue;
            }
            const attempt = applyPlanOps(state.tasks, mapped.ops, applyContext(), "atomic");
            if (!attempt.ok) {
              errors = attempt.errors;
              continue;
            }
            applied = attempt;
            rationale = result.value.rationale;
            guidance = result.value.synthesisGuidance;
          }
          if (!applied) span.addEvent("plan.fallback", { errors: truncate(errors.join("; "), 2000) });
        }

        if (!applied) {
          const { agent, capability } = fallbackAgent(deps.agents);
          const result = applyPlanOps(state.tasks, singleTaskOps(intent, agent, capability, "fallback"), applyContext(), "atomic");
          if (!result.ok) throw new Error(`Could not create a fallback plan: ${result.errors.join("; ")}`);
          applied = result;
          path = "fallback";
          rationale = "Planning did not produce a valid plan; falling back to a single generalist task.";
        }

        const events = new DurableEvents(
          state.control.eventSeq,
          { runId: state.run.runId, threadId: state.run.threadId, planVersion: applied.planVersion, trace: traceRefFromRun(state.run) },
          () => now,
        );
        const created = Object.values(applied.changed)
          .filter((task) => task.status === "submitted")
          .sort((a, b) => compareTaskIds(a.id, b.id));
        events.emit("plan.created", { version: applied.planVersion, path, rationale, tasks: created.map(toTaskPreview), tier, model, usage });
        span.setAttributes({ "analytax.plan.path": path, "analytax.plan.tasks": created.length, "analytax.plan.version": applied.planVersion });
        recordDurableEvents(events.events);

        return {
          tasks: applied.changed,
          plan: {
            ...state.plan,
            version: applied.planVersion,
            path,
            rationale,
            synthesisGuidance: guidance,
            intentHash,
            approved: !hitl.approvePlan,
            feedback: null,
            approvalErrors: [],
            createdAt: now,
          },
          control: {
            ...state.control,
            taskSeq: applied.taskSeq,
            spentFingerprints: applied.spentFingerprints,
            usage: addUsage(state.control.usage, usage),
            eventSeq: events.lastSeq,
          },
          events: events.events,
        };
      },
    );
  };
}
