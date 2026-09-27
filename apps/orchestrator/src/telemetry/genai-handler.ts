import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import type { Serialized } from "@langchain/core/load/serializable";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import { SpanKind, SpanStatusCode, trace, type Attributes, type Context, type Span } from "@opentelemetry/api";
import { usageFromMessage } from "../models/usage.js";
import { truncate } from "../util/text.js";
import { telemetryEnabled } from "./instrument.js";
import { recordOperationDuration, recordTokenUsage, recordToolDuration } from "./metrics.js";
import { tracer, withHandler } from "./tracing.js";

type Entry = { span: Span; started: number; model: string; tool: string | null };

const captureContent = (): boolean => process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT === "true";

/**
 * LangChain callbacks → OpenTelemetry spans following the (development-status) GenAI semantic conventions:
 * `chat {model}` (CLIENT) and `execute_tool {tool}` (INTERNAL), parented under an explicit orchestration span.
 */
export class OtelGenAiCallbackHandler extends BaseCallbackHandler {
  name = "analytax_otel_genai";
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly parent: Context,
    private readonly attributes: Attributes = {},
  ) {
    super({ _awaitHandler: true });
    this.awaitHandlers = true;
  }

  private parentFor(parentRunId?: string): Context {
    const entry = parentRunId ? this.entries.get(parentRunId) : undefined;
    return entry ? trace.setSpan(this.parent, entry.span) : this.parent;
  }

  private finish(runId: string): Entry | undefined {
    const entry = this.entries.get(runId);
    if (entry) this.entries.delete(runId);
    return entry;
  }

  override handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    const invocation = extraParams?.invocation_params as { model?: string } | undefined;
    const model = String(metadata?.ls_model_name ?? invocation?.model ?? llm.id?.at(-1) ?? "unknown");
    const span = tracer().startSpan(
      `chat ${model}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          ...this.attributes,
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": "gcp.gemini",
          "gen_ai.request.model": model,
        },
      },
      this.parentFor(parentRunId),
    );
    if (captureContent()) {
      span.setAttribute(
        "gen_ai.input.messages",
        truncate(JSON.stringify(messages.flat().map((message) => ({ role: message.type, content: message.content }))), 16_000),
      );
    }
    this.entries.set(runId, { span, started: performance.now(), model, tool: null });
  }

  override handleLLMEnd(output: LLMResult, runId: string): void {
    const entry = this.finish(runId);
    if (!entry) return;
    const generation = output.generations?.[0]?.[0] as { message?: BaseMessage; generationInfo?: Record<string, unknown> } | undefined;
    const usage = usageFromMessage(generation?.message);
    entry.span.setAttributes({
      "gen_ai.response.model": entry.model,
      "gen_ai.usage.input_tokens": usage.inputTokens,
      "gen_ai.usage.output_tokens": usage.outputTokens,
      "gen_ai.usage.reasoning.output_tokens": usage.reasoningTokens,
      "gen_ai.usage.cache_read.input_tokens": usage.cachedTokens,
    });
    const responseMetadata = (generation?.message as { response_metadata?: Record<string, unknown> } | undefined)?.response_metadata;
    const finishReason = generation?.generationInfo?.finishReason ?? responseMetadata?.finish_reason;
    if (finishReason) entry.span.setAttribute("gen_ai.response.finish_reasons", [String(finishReason)]);
    if (captureContent() && generation?.message) {
      entry.span.setAttribute("gen_ai.output.messages", truncate(JSON.stringify(generation.message.content), 16_000));
    }
    entry.span.end();
    const seconds = (performance.now() - entry.started) / 1000;
    recordTokenUsage(usage, { model: entry.model, operation: "chat" });
    recordOperationDuration(seconds, { model: entry.model, operation: "chat" });
  }

  override handleLLMError(error: unknown, runId: string): void {
    const entry = this.finish(runId);
    if (!entry) return;
    const err = error as Error;
    entry.span.recordException(err);
    entry.span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
    entry.span.setAttribute("error.type", err?.name ?? "Error");
    entry.span.end();
    recordOperationDuration((performance.now() - entry.started) / 1000, { model: entry.model, operation: "chat", error: err?.name ?? "Error" });
  }

  override handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
    toolCallId?: string,
  ): void {
    const name = runName ?? tool.id?.at(-1) ?? "tool";
    const mcpServer = /^mcp__([a-z][a-z0-9-]{0,23})__/.exec(name)?.[1];
    const span = tracer().startSpan(
      `execute_tool ${name}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          ...this.attributes,
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": name,
          "gen_ai.tool.type": mcpServer ? "extension" : "function",
          ...(mcpServer ? { "mcp.method.name": "tools/call", "analytax.mcp.server": mcpServer } : {}),
          ...(toolCallId ? { "gen_ai.tool.call.id": toolCallId } : {}),
        },
      },
      this.parentFor(parentRunId),
    );
    if (captureContent()) span.setAttribute("gen_ai.tool.call.arguments", truncate(input, 4_000));
    this.entries.set(runId, { span, started: performance.now(), model: "", tool: name });
  }

  override handleToolEnd(output: unknown, runId: string): void {
    const entry = this.finish(runId);
    if (!entry) return;
    if (captureContent()) {
      const text = typeof output === "string" ? output : JSON.stringify((output as { content?: unknown })?.content ?? output);
      entry.span.setAttribute("gen_ai.tool.call.result", truncate(text ?? "", 4_000));
    }
    entry.span.end();
    recordToolDuration((performance.now() - entry.started) / 1000, { tool: entry.tool ?? "tool", ok: true });
  }

  override handleToolError(error: unknown, runId: string): void {
    const entry = this.finish(runId);
    if (!entry) return;
    const err = error as Error;
    entry.span.recordException(err);
    entry.span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
    entry.span.setAttribute("error.type", err?.name ?? "Error");
    entry.span.end();
    recordToolDuration((performance.now() - entry.started) / 1000, { tool: entry.tool ?? "tool", ok: false });
  }
}

/** Callbacks for an LLM call inside a node: inherited handlers + a GenAI span handler (when telemetry is on). */
export function callbacksFor(config: { callbacks?: Callbacks }, parent: Context, attributes: Attributes = {}): Callbacks | undefined {
  return withHandler(config.callbacks, telemetryEnabled() ? new OtelGenAiCallbackHandler(parent, attributes) : null);
}
