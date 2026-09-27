import { randomUUID } from "node:crypto";
import { addUsage, type IntentAnalysis, type RunInput, type RunMeta } from "@analytax/contracts";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { AgentRegistry } from "../../agents/registry.js";
import { DurableEvents, traceRefFromRun } from "../../control/events.js";
import { referencedServers } from "../../mcp/refs.js";
import { analyzeIntent } from "../../roles/prompts.js";
import { callbacksFor } from "../../telemetry/genai-handler.js";
import { recordDurableEvents } from "../../telemetry/metrics.js";
import { startRunTrace, withSpan } from "../../telemetry/tracing.js";
import { shortHash, stableStringify } from "../../util/hash.js";
import type { OrchestratorDeps } from "../deps.js";
import { latestHumanText, resolveRunOptions, runIdOf, threadIdOf } from "../run-options.js";
import type { State, Update } from "../state.js";

/** How long a new run waits for MCP servers to connect before planning without the slow ones. */
const MCP_INTAKE_WAIT_MS = 3_000;

function normalizeIntent(intent: IntentAnalysis, agents: AgentRegistry, answered: boolean): IntentAnalysis {
  const capabilities = agents.allCapabilities();
  const fallbackCapability = agents.fallback()?.capabilities[0] ?? capabilities[0] ?? "general_qa";
  return {
    ...intent,
    suggestedCapability: capabilities.includes(intent.suggestedCapability) ? intent.suggestedCapability : fallbackCapability,
    ambiguity: {
      isAmbiguous: intent.ambiguity.isAmbiguous && !answered,
      questions: intent.ambiguity.questions.map((question) => question.trim()).filter(Boolean).slice(0, 3),
    },
  };
}

export function createIntakeNode(deps: OrchestratorDeps) {
  return async (state: State, config: LangGraphRunnableConfig): Promise<Update> => {
    const query = latestHumanText(state.messages) ?? state.input?.query ?? "";
    if (!query) throw new Error("Submit a human message containing the client's query.");
    if (state.final && state.input && state.input.query !== query) {
      throw new Error("This thread has already answered a query. Start a new thread for a new query.");
    }

    const nowDate = deps.clock.now();
    const now = nowDate.toISOString();
    const options = resolveRunOptions(state.runOptions, config.context, deps.config.orchestrator, deps.faultsEnabled);
    const input: RunInput = state.input && state.input.query === query ? state.input : { query, clarifications: [], submittedAt: now };
    const threadId = threadIdOf(config);

    let run: RunMeta = state.run;
    let control = state.control;
    const firstPass = !run.startedAt;
    if (firstPass) {
      // Snapshot the MCP servers agent cards use, once per run: the planner plans with what is available now.
      const cards = deps.agents.list();
      const serverIds = referencedServers(cards);
      const off = new Set(options.mcp.allOff ? serverIds : options.mcp.disabled);
      const toolServers = serverIds.length > 0 ? await deps.mcp.runSnapshot(cards, off, MCP_INTAKE_WAIT_MS) : [];
      const trace = startRunTrace({ "gen_ai.conversation.id": threadId });
      run = {
        runId: runIdOf(config) ?? randomUUID(),
        threadId,
        traceparent: trace.traceparent,
        traceId: trace.traceId,
        startedAt: now,
        queryHash: null,
        hitl: options.hitl,
        maxConcurrency: options.maxConcurrency,
        budgetUsd: options.budgetUsd,
        faultsEnabled: deps.faultsEnabled && options.demoFaults.length > 0,
        ...(toolServers.length > 0 ? { toolServers } : {}),
      };
      control = { ...control, deadlineAt: new Date(nowDate.getTime() + options.deadlineSec * 1000).toISOString() };
    }

    const events = new DurableEvents(
      control.eventSeq,
      { runId: run.runId, threadId: run.threadId, planVersion: state.plan.version, trace: traceRefFromRun(run) },
      () => now,
    );
    if (firstPass) {
      events.emit("run.started", {
        query,
        hitl: options.hitl,
        maxConcurrency: options.maxConcurrency,
        deadlineAt: control.deadlineAt,
        faultsEnabled: run.faultsEnabled,
        ...(run.toolServers ? { toolServers: run.toolServers } : {}),
      });
    }

    const inputHash = shortHash(stableStringify({ query: input.query, clarifications: input.clarifications }));
    if (state.intent && state.run.queryHash === inputHash) {
      return { input, run, control: { ...control, eventSeq: events.lastSeq }, events: events.events };
    }

    const result = await withSpan(
      "orchestrator.intake",
      { parent: run.traceparent, attributes: { "analytax.node": "intake", "gen_ai.conversation.id": threadId } },
      (_span, spanContext) =>
        analyzeIntent(deps.structured, {
          query,
          clarifications: input.clarifications,
          capabilities: deps.agents.allCapabilities(),
          today: now.slice(0, 10),
          callbacks: callbacksFor(config, spanContext, { "analytax.role": "intake" }),
          signal: config.signal,
        }),
    );
    const intent = normalizeIntent(result.value, deps.agents, input.clarifications.length > 0);
    events.emit("intent.analyzed", { intent, tier: result.tier, model: result.model, usage: result.usage });
    recordDurableEvents(events.events);

    return {
      input,
      run: { ...run, queryHash: inputHash },
      intent,
      control: { ...control, usage: addUsage(control.usage, result.usage), eventSeq: events.lastSeq },
      events: events.events,
    };
  };
}
