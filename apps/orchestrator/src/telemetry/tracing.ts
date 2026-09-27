import type { TraceRef } from "@analytax/contracts";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { isGraphInterrupt } from "@langchain/langgraph";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  isSpanContextValid,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";

export const tracer = () => trace.getTracer("analytax", "0.1.0");

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Parent context from a stored W3C traceparent — keeps one trace per run across supersteps, interrupts and processes. */
export function contextFromTraceparent(traceparent: string | null | undefined): Context {
  const match = traceparent ? TRACEPARENT.exec(traceparent) : null;
  if (!match?.[1] || !match[2] || !match[3]) return context.active();
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: match[1],
    spanId: match[2],
    traceFlags: Number.parseInt(match[3], 16),
    isRemote: true,
  });
}

export function traceparentOf(span: Span): string | null {
  const spanContext = span.spanContext();
  if (!isSpanContextValid(spanContext)) return null;
  return `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags.toString(16).padStart(2, "0")}`;
}

export function traceRefOf(span: Span): TraceRef | null {
  const spanContext = span.spanContext();
  return isSpanContextValid(spanContext) ? { traceId: spanContext.traceId, spanId: spanContext.spanId } : null;
}

/** Root `invoke_workflow` span. Ended immediately; every later node span parents to it via the stored traceparent. */
export function startRunTrace(attributes: Attributes): { traceparent: string | null; traceId: string | null } {
  const span = tracer().startSpan(
    "invoke_workflow analytax",
    {
      kind: SpanKind.INTERNAL,
      attributes: { "gen_ai.operation.name": "invoke_workflow", "gen_ai.workflow.name": "analytax", ...attributes },
    },
    ROOT_CONTEXT,
  );
  const traceparent = traceparentOf(span);
  span.end();
  return { traceparent, traceId: traceparent ? span.spanContext().traceId : null };
}

export async function withSpan<T>(
  name: string,
  options: { parent: string | null | undefined; attributes?: Attributes; kind?: SpanKind },
  fn: (span: Span, spanContext: Context) => Promise<T>,
): Promise<T> {
  const parent = contextFromTraceparent(options.parent);
  const span = tracer().startSpan(name, { kind: options.kind ?? SpanKind.INTERNAL, attributes: options.attributes }, parent);
  const spanContext = trace.setSpan(parent, span);
  try {
    const result = await context.with(spanContext, () => fn(span, spanContext));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    if (!isGraphInterrupt(error)) {
      const err = error as Error;
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
      span.setAttribute("error.type", err?.name ?? "Error");
    }
    throw error;
  } finally {
    span.end();
  }
}

/** Adds a handler while preserving inherited callbacks (LangGraph stream handlers, LangSmith, …). */
export function withHandler(parent: Callbacks | undefined, handler: BaseCallbackHandler | null): Callbacks | undefined {
  if (!handler) return parent;
  if (!parent) return [handler];
  if (Array.isArray(parent)) return [...parent, handler];
  return parent.copy([handler], true);
}
