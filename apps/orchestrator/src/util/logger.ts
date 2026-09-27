import { trace } from "@opentelemetry/api";
import { pino } from "pino";

/** Structured JSON logs correlated with the active OpenTelemetry span. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.OTEL_SERVICE_NAME ?? "analytax-orchestrator" },
  mixin() {
    const context = trace.getActiveSpan()?.spanContext();
    return context ? { trace_id: context.traceId, span_id: context.spanId } : {};
  },
});
