import {
  addUsage,
  isTerminalStatus,
  type FinalAnswer,
  type Source,
  type TaskResult,
  type Tier,
  type Usage,
} from "@analytax/contracts";
import { AIMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { ArtifactStore } from "../../artifacts/store.js";
import { DurableEvents, traceRefFromRun } from "../../control/events.js";
import { collectGaps } from "../../control/gaps.js";
import { sortedTasks, topologicalSort } from "../../planning/dag.js";
import { countTasks } from "../../planning/readiness.js";
import { synthesizeAnswer, type SynthesisEntry } from "../../roles/prompts.js";
import { callbacksFor } from "../../telemetry/genai-handler.js";
import { recordDurableEvents } from "../../telemetry/metrics.js";
import { withSpan } from "../../telemetry/tracing.js";
import { truncate, uniq } from "../../util/text.js";
import type { OrchestratorDeps } from "../deps.js";
import { threadIdOf } from "../run-options.js";
import type { State, Update } from "../state.js";

async function loadOutput(result: TaskResult, artifacts: ArtifactStore): Promise<string> {
  if (result.output !== null) return result.output;
  if (result.outputRef) return (await artifacts.read(result.outputRef)) || result.summary;
  return result.summary;
}

function dedupeSources(results: readonly TaskResult[]): Source[] {
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const result of results) {
    for (const source of result.sources) {
      const key = (source.url ?? source.title).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(source);
    }
  }
  return sources.slice(0, 40);
}

export function createSynthesizeNode(deps: OrchestratorDeps) {
  return async (state: State, config: LangGraphRunnableConfig): Promise<Update> => {
    if (state.final) return {};
    const nowDate = deps.clock.now();
    const now = nowDate.toISOString();
    const reason = state.control.route?.kind === "synthesize" ? state.control.route.reason : "complete";
    const artifacts = new ArtifactStore(config.store, state.run.threadId ?? threadIdOf(config));

    return withSpan(
      "orchestrator.synthesize",
      { parent: state.run.traceparent, attributes: { "analytax.node": "synthesize", "analytax.synthesis.reason": reason } },
      async (span, spanContext) => {
        const unfinished = sortedTasks(state.tasks)
          .filter((task) => !isTerminalStatus(task.status))
          .map((task) => ({ taskId: task.id, title: task.title, reason: `not completed (run stopped: ${reason})` }));
        const gaps = [...collectGaps(state.tasks), ...unfinished];

        // Usable results in dependency order; a completed revision replaces its original.
        const { order } = topologicalSort(state.tasks);
        const usable = order
          .map((id) => state.tasks[id]!)
          .filter((task) => {
            const result = state.results[task.id];
            if (!result || !(task.status === "completed" || result.degraded)) return false;
            return !task.supersededBy.some((id) => state.tasks[id]?.revisionOf === task.id && state.tasks[id]?.status === "completed");
          });
        const usableResults = usable.map((task) => state.results[task.id]!);
        const sinkIds = new Set(usable.filter((task) => !usable.some((other) => other.dependsOn.includes(task.id))).map((task) => task.id));
        const sources = dedupeSources(usableResults);

        let answer: string;
        let limitations: string[] = [];
        let synthesisUsage: Usage | null = null;
        let tier: Tier | null = null;
        let model: string | null = null;

        const onlyResult = usableResults[0];
        if (usable.length === 0) {
          answer = gaps.length
            ? `I wasn't able to complete this request. These parts could not be finished:\n\n${gaps.map((gap) => `- ${gap.title}: ${gap.reason}`).join("\n")}`
            : "I wasn't able to produce an answer for this request.";
        } else if (state.plan.path === "direct" && usable.length === 1 && gaps.length === 0 && onlyResult && !onlyResult.degraded) {
          answer = await loadOutput(onlyResult, artifacts);
        } else {
          const budgetChars = deps.models.resolve(deps.config.models.roles.synthesizer).contextTokens * 4 * 0.7;
          const perSink = Math.max(4_000, Math.floor(budgetChars / Math.max(1, sinkIds.size)));
          const entries: SynthesisEntry[] = [];
          for (const task of usable) {
            const result = state.results[task.id]!;
            entries.push({
              title: task.title,
              summary: result.summary,
              keyFindings: result.keyFindings,
              output: sinkIds.has(task.id) ? truncate(await loadOutput(result, artifacts), perSink) : null,
              degraded: result.degraded,
              stale: task.staleInputs,
            });
          }
          const result = await synthesizeAnswer(deps.structured, {
            query: state.input?.query ?? "",
            intent: state.intent,
            guidance: state.plan.synthesisGuidance,
            entries,
            sources,
            gaps,
            assumptions: uniq(usableResults.flatMap((entry) => entry.assumptions)).slice(0, 10),
            clarifications: state.input?.clarifications ?? [],
            callbacks: callbacksFor(config, spanContext, { "analytax.role": "synthesizer" }),
            signal: config.signal,
          });
          answer = result.value.answer;
          limitations = result.value.limitations.map((limitation) => limitation.trim()).filter(Boolean);
          synthesisUsage = result.usage;
          tier = result.tier;
          model = result.model;
        }

        const status: FinalAnswer["status"] = gaps.length > 0 || (reason !== "complete" && reason !== "partial") ? "partial" : "complete";
        const final: FinalAnswer = {
          status,
          answer,
          limitations,
          sources,
          gaps,
          completedTaskIds: usable.map((task) => task.id),
          producedAt: now,
        };
        const usage = synthesisUsage ? addUsage(state.control.usage, synthesisUsage) : state.control.usage;
        const events = new DurableEvents(
          state.control.eventSeq,
          { runId: state.run.runId, threadId: state.run.threadId, planVersion: state.plan.version, trace: traceRefFromRun(state.run) },
          () => now,
        );
        events.emit("run.completed", {
          status,
          durationMs: state.run.startedAt ? Math.max(0, nowDate.getTime() - Date.parse(state.run.startedAt)) : 0,
          usage,
          tier,
          model,
          synthesisUsage,
          counts: countTasks(state.tasks),
        });
        span.setAttributes({ "analytax.run.status": status, "analytax.run.gaps": gaps.length, "analytax.run.cost_usd": usage.costUsd });
        recordDurableEvents(events.events);

        const content = limitations.length ? `${answer}\n\n**Limitations**\n${limitations.map((limitation) => `- ${limitation}`).join("\n")}` : answer;
        return {
          final,
          messages: [new AIMessage({ content, name: "analytax" })],
          control: { ...state.control, usage, eventSeq: events.lastSeq },
          events: events.events,
        };
      },
    );
  };
}
