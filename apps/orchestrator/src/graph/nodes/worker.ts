import {
  TaskOutcomeWire,
  addUsage,
  emptyUsage,
  outcomeFromWire,
  type ArtifactRef,
  type CheckResult,
  type ModelUsage,
  type TaskOutcome,
  type Verdict,
  type WorkerError,
  type WorkerReport,
} from "@analytax/contracts";
import { isGraphInterrupt, type LangGraphRunnableConfig } from "@langchain/langgraph";
import type { Context, Span } from "@opentelemetry/api";
import { z } from "zod";
import type { EphemeralEmit } from "../../agents/sessions.js";
import { dispatchSessions } from "../../agents/sessions.js";
import { renderTaskPrompt } from "../../agents/prompt.js";
import { ArtifactStore } from "../../artifacts/store.js";
import { createEphemeralEmitter, traceRefFromTraceparent } from "../../control/events.js";
import type { WorkerInput } from "../../control/worker-input.js";
import { InjectedTransientError, faultOutcome, followUpProposal, matchFault } from "../../demo/faults.js";
import { blockingFailures, runChecks } from "../../evaluation/checks.js";
import { fallbackVerdict, judgeOutcome, judgeTier, rulesVerdict, shouldSkipJudge, skippedVerdict } from "../../evaluation/judge.js";
import { usageFromMessages, withCost } from "../../models/usage.js";
import { callbacksFor } from "../../telemetry/genai-handler.js";
import type { ToolsForCard } from "../../mcp/hub.js";
import { recordAgentDuration } from "../../telemetry/metrics.js";
import { traceRefOf, withSpan } from "../../telemetry/tracing.js";
import { classifyError, errorMessage } from "../../util/errors.js";
import { shortHash } from "../../util/hash.js";
import { logger } from "../../util/logger.js";
import { estimateTokens, normalizeText, truncate } from "../../util/text.js";
import type { OrchestratorDeps } from "../deps.js";
import type { Update } from "../state.js";

const HEARTBEAT_MS = 15_000;

async function preloadArtifacts(input: WorkerInput, artifacts: ArtifactStore, contextTokens: number): Promise<Map<string, string>> {
  const preloaded = new Map<string, string>();
  if (!artifacts.available) return preloaded;
  let remaining = contextTokens * 0.6 - input.packet.budget.usedTokens;
  for (const entry of input.packet.upstream) {
    if (entry.mode !== "reference" || !entry.artifactKey || remaining <= 0) continue;
    const ref = input.packet.artifacts[entry.artifactKey];
    if (!ref) continue;
    const text = await artifacts.read(ref);
    const cost = estimateTokens(text);
    if (text && cost <= remaining) {
      preloaded.set(entry.artifactKey, text);
      remaining -= cost;
    }
  }
  return preloaded;
}

/** How long a dispatch waits for an MCP server that is still connecting. During backoff it does not wait at all. */
const MCP_DISPATCH_WAIT_MS = 5_000;

/** Tells the agent which of its tool servers are down, so it works around them instead of guessing. */
function withUnavailableToolsNote(prompt: string, unavailable: ToolsForCard["unavailable"]): string {
  if (unavailable.length === 0) return prompt;
  const lines = unavailable.map((server) => `- ${server.title} (mcp__${server.id}__*): ${server.reason}`);
  return [
    prompt,
    "",
    "## Unavailable tools",
    "These tool servers cannot be used for this attempt. Work without them and say so if it limits the result:",
    ...lines,
  ].join("\n");
}

async function runDispatch(
  deps: OrchestratorDeps,
  input: WorkerInput,
  config: LangGraphRunnableConfig,
  emit: EphemeralEmit,
  artifacts: ArtifactStore,
  span: Span,
  spanContext: Context,
): Promise<WorkerReport> {
  const { dispatch, task, packet } = input;
  const card = deps.agents.require(dispatch.agentId);
  const orchestrator = deps.config.orchestrator;
  const started = Date.now();
  const startedAt = deps.clock.now().toISOString();

  const release = dispatchSessions.register({
    dispatchId: dispatch.dispatchId,
    emit,
    artifacts: new Map(Object.entries(packet.artifacts)),
    readArtifact: (ref) => artifacts.read(ref),
  });
  const heartbeat = setInterval(() => emit("heartbeat", { elapsedMs: Date.now() - started }), HEARTBEAT_MS);
  heartbeat.unref?.();
  // MCP tools for this dispatch: live availability, minus the servers this run turned off.
  const mcp = await deps.mcp.toolsFor(card, new Set(input.run.toolServersOff ?? []), { waitMs: MCP_DISPATCH_WAIT_MS });
  emit("agent.started", {
    tier: dispatch.tier,
    model: dispatch.model,
    ...(mcp.unavailable.length > 0 ? { unavailableToolServers: mcp.unavailable.map((server) => server.id) } : {}),
  });

  const timeout = AbortSignal.timeout(card.limits.timeoutMs);
  const signal = config.signal ? AbortSignal.any([config.signal, timeout]) : timeout;
  const callbacks = callbacksFor(config, spanContext, { "gen_ai.agent.id": card.id, "analytax.task.id": task.id });
  const fault = matchFault(input);

  let outcome: TaskOutcome | null = null;
  let error: WorkerError | null = null;
  let usage = emptyUsage();

  try {
    if (fault?.kind === "transient_error") throw new InjectedTransientError("Injected transient error (demo fault)");
    const injected = fault ? faultOutcome(fault, input) : null;
    if (injected) {
      outcome = injected;
    } else {
      const resolved = deps.models.resolve(dispatch.tier);
      const preloaded = await preloadArtifacts(input, artifacts, resolved.contextTokens);
      const partial = task.partialRef ? truncate(await artifacts.read(task.partialRef), 12_000) : null;
      const prompt = withUnavailableToolsNote(renderTaskPrompt(input, preloaded, partial || null), mcp.unavailable);
      const result = await deps.agentRunner.run({
        agentId: card.id,
        tier: dispatch.tier,
        prompt,
        dispatchId: dispatch.dispatchId,
        signal,
        callbacks,
        mcp: { tools: mcp.tools, fingerprint: mcp.fingerprint },
      });
      usage = withCost(usageFromMessages(result.messages), dispatch.model, deps.config.models.pricing);
      if (result.structured) {
        const parsed = TaskOutcomeWire.safeParse(result.structured);
        if (parsed.success) outcome = outcomeFromWire(parsed.data);
        else error = { kind: "schema", transient: false, signature: "schema:task-outcome", message: z.prettifyError(parsed.error) };
      } else {
        error = {
          kind: "limit",
          transient: false,
          signature: "limit:no-outcome",
          message: "The agent stopped without submitting an outcome (model or tool-call budget exhausted).",
        };
      }
      if (outcome && fault?.kind === "propose_follow_up") {
        outcome = { ...outcome, proposals: [...outcome.proposals, followUpProposal(input)].slice(0, 3) };
      }
    }
  } catch (caught) {
    if (isGraphInterrupt(caught) || (config.signal?.aborted && !timeout.aborted)) throw caught;
    error = classifyError(caught, { timedOut: timeout.aborted });
  } finally {
    clearInterval(heartbeat);
    release();
  }
  emit("agent.finished", {
    outcomeStatus: outcome?.status ?? null,
    error: error ? `${error.kind}: ${truncate(error.message, 200)}` : null,
    durationMs: Date.now() - started,
  });

  let outputRef: ArtifactRef | null = null;
  if (outcome?.output) {
    const large = Buffer.byteLength(outcome.output, "utf8") > orchestrator.artifacts.inlineMaxBytes;
    if (large || outcome.status === "blocked" || outcome.status === "partial") {
      try {
        outputRef = await artifacts.put(task.id, dispatch.attempt, outcome.output);
      } catch (storeError) {
        logger.warn({ err: errorMessage(storeError), taskId: task.id }, "artifact store write failed; keeping output inline");
      }
    }
  }
  const outputFingerprint = outcome?.output.trim() ? shortHash(normalizeText(outcome.output)) : null;

  let checks: CheckResult[] = [];
  let verdict: Verdict | null = null;
  let judge: ModelUsage | null = null;
  if (outcome && (outcome.status === "completed" || outcome.status === "partial")) {
    checks = runChecks(task, outcome);
    if (fault?.kind === "reject") {
      checks = [...checks, { id: "demo.reject", passed: false, severity: "blocker", message: "Injected rejection (demo fault)" }];
      verdict = rulesVerdict(task, checks, "Injected rejection (demo fault): address every acceptance criterion explicitly.");
    } else if (blockingFailures(checks).length > 0) {
      verdict = rulesVerdict(task, checks);
    } else if (
      shouldSkipJudge({
        task,
        outcome,
        cardEvaluation: card.evaluation,
        attempt: dispatch.attempt,
        isSink: input.isSink,
        skipConfidence: orchestrator.evaluation.skipConfidence,
      })
    ) {
      verdict = skippedVerdict(task, outcome);
    } else {
      emit("evaluation.started", { mode: "llm" });
      const judgedTier = judgeTier(dispatch.tier, deps.config.models.roles.judge);
      try {
        const judged = await judgeOutcome({
          invoker: deps.structured,
          task,
          outcome,
          packet,
          tier: judgedTier,
          maxOutputChars: orchestrator.evaluation.maxOutputCharsForJudge,
          callbacks: callbacksFor(config, spanContext, { "analytax.role": "judge", "analytax.task.id": task.id }),
          signal: config.signal,
        });
        verdict = judged.verdict;
        usage = addUsage(usage, judged.usage);
        judge = { tier: judgedTier, model: judged.model, usage: judged.usage };
      } catch (judgeError) {
        if (isGraphInterrupt(judgeError) || config.signal?.aborted) throw judgeError;
        verdict = fallbackVerdict(task, outcome, errorMessage(judgeError));
      }
    }
  }

  return {
    dispatchId: dispatch.dispatchId,
    taskId: task.id,
    attempt: dispatch.attempt,
    wave: dispatch.wave,
    agentId: dispatch.agentId,
    tier: dispatch.tier,
    model: dispatch.model,
    outcome,
    outputRef,
    error,
    checks,
    verdict,
    outputFingerprint,
    usage,
    judge,
    startedAt,
    durationMs: Date.now() - started,
    trace: traceRefOf(span),
  };
}

/** Parallel worker: runs one agent attempt plus evaluation, and writes ONLY its report to `inbox`. */
export function createWorkerNode(deps: OrchestratorDeps) {
  return async (input: WorkerInput, config: LangGraphRunnableConfig): Promise<Update> => {
    const { dispatch, task } = input;
    const card = deps.agents.require(dispatch.agentId);
    const threadId = input.run.threadId ?? "local";
    const artifacts = new ArtifactStore(config.store, threadId);
    const emit = createEphemeralEmitter({
      writer: config.writer,
      base: {
        runId: input.run.runId,
        threadId,
        planVersion: input.run.planVersion,
        trace: traceRefFromTraceparent(input.run.traceparent),
      },
      scope: { taskId: task.id, agentId: dispatch.agentId, attempt: dispatch.attempt, wave: dispatch.wave, dispatchId: dispatch.dispatchId },
      now: () => deps.clock.now().toISOString(),
    });

    return withSpan(
      `invoke_agent ${card.id}`,
      {
        parent: input.run.traceparent,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.provider.name": "gcp.gemini",
          "gen_ai.agent.id": card.id,
          "gen_ai.agent.name": card.name,
          "gen_ai.request.model": dispatch.model,
          "gen_ai.conversation.id": threadId,
          "analytax.task.id": task.id,
          "analytax.dispatch.id": dispatch.dispatchId,
          "analytax.attempt": dispatch.attempt,
          "analytax.tier": dispatch.tier,
        },
      },
      async (span, spanContext) => {
        const report = await runDispatch(deps, input, config, emit, artifacts, span, spanContext);
        span.setAttributes({
          "gen_ai.usage.input_tokens": report.usage.inputTokens,
          "gen_ai.usage.output_tokens": report.usage.outputTokens,
          "gen_ai.usage.reasoning.output_tokens": report.usage.reasoningTokens,
          "analytax.outcome.status": report.outcome?.status ?? "none",
          "analytax.verdict": report.verdict?.decision ?? "none",
          "analytax.evaluated_by": report.verdict?.evaluatedBy ?? "none",
        });
        if (report.error) span.setAttribute("error.type", report.error.kind);
        recordAgentDuration(report.durationMs / 1000, {
          agent: card.id,
          tier: dispatch.tier,
          outcome: report.error ? `error:${report.error.kind}` : (report.verdict?.decision ?? report.outcome?.status ?? "none"),
        });
        return { inbox: { put: { [dispatch.dispatchId]: report } } };
      },
    );
  };
}
