import type { LifecycleEvent, Usage } from "@analytax/contracts";
import { metrics, type Counter, type Histogram } from "@opentelemetry/api";

type Instruments = {
  tokenUsage: Histogram;
  operationDuration: Histogram;
  agentDuration: Histogram;
  toolDuration: Histogram;
  taskOutcomes: Counter;
  taskAttempts: Histogram;
  planPatches: Counter;
  guardTrips: Counter;
  waveDuration: Histogram;
  runDuration: Histogram;
  runCost: Histogram;
};

const TOKEN_BUCKETS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864];
const DURATION_BUCKETS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92];

let instruments: Instruments | null = null;

/** Created lazily so they bind to the real MeterProvider registered by startTelemetry(). */
function get(): Instruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter("analytax", "0.1.0");
  instruments = {
    tokenUsage: meter.createHistogram("gen_ai.client.token.usage", {
      unit: "{token}",
      description: "Tokens used per GenAI operation",
      advice: { explicitBucketBoundaries: TOKEN_BUCKETS },
    }),
    operationDuration: meter.createHistogram("gen_ai.client.operation.duration", {
      unit: "s",
      description: "Duration of GenAI client operations",
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
    agentDuration: meter.createHistogram("gen_ai.invoke_agent.duration", { unit: "s", advice: { explicitBucketBoundaries: DURATION_BUCKETS } }),
    toolDuration: meter.createHistogram("gen_ai.execute_tool.duration", { unit: "s", advice: { explicitBucketBoundaries: DURATION_BUCKETS } }),
    taskOutcomes: meter.createCounter("analytax.task.outcomes", { description: "Task lifecycle outcomes by status/agent/tier" }),
    taskAttempts: meter.createHistogram("analytax.task.attempts", { description: "Semantic attempts per accepted task" }),
    planPatches: meter.createCounter("analytax.plan.patches", { description: "Plan operations applied, by op and source" }),
    guardTrips: meter.createCounter("analytax.guard.trips", { description: "Loop/budget guards tripped" }),
    waveDuration: meter.createHistogram("analytax.wave.duration", { unit: "s", advice: { explicitBucketBoundaries: DURATION_BUCKETS } }),
    runDuration: meter.createHistogram("analytax.run.duration", { unit: "s" }),
    runCost: meter.createHistogram("analytax.run.cost_usd", { unit: "USD" }),
  };
  return instruments;
}

const genAiBase = (model: string, operation: string) => ({
  "gen_ai.operation.name": operation,
  "gen_ai.provider.name": "gcp.gemini",
  "gen_ai.request.model": model,
});

export function recordTokenUsage(usage: Usage, attributes: { model: string; operation: string }): void {
  const base = genAiBase(attributes.model, attributes.operation);
  if (usage.inputTokens > 0) get().tokenUsage.record(usage.inputTokens, { ...base, "gen_ai.token.type": "input" });
  if (usage.outputTokens > 0) get().tokenUsage.record(usage.outputTokens, { ...base, "gen_ai.token.type": "output" });
}

export function recordOperationDuration(seconds: number, attributes: { model: string; operation: string; error?: string }): void {
  get().operationDuration.record(seconds, { ...genAiBase(attributes.model, attributes.operation), ...(attributes.error ? { "error.type": attributes.error } : {}) });
}

export function recordAgentDuration(seconds: number, attributes: { agent: string; tier: string; outcome: string }): void {
  get().agentDuration.record(seconds, { "gen_ai.agent.name": attributes.agent, "analytax.tier": attributes.tier, "analytax.outcome": attributes.outcome });
}

export function recordToolDuration(seconds: number, attributes: { tool: string; ok: boolean }): void {
  get().toolDuration.record(seconds, { "gen_ai.tool.name": attributes.tool, ...(attributes.ok ? {} : { "error.type": "tool_error" }) });
}

/** Derives orchestration metrics from durable lifecycle events (single source of truth for UI and metrics). */
export function recordDurableEvents(events: readonly LifecycleEvent[]): void {
  const m = get();
  for (const event of events) {
    const agent = event.agentId ?? "unknown";
    switch (event.type) {
      case "task.completed":
        m.taskOutcomes.add(1, { status: "completed", agent, tier: event.data.tier });
        m.taskAttempts.record(event.data.attempt, { agent });
        break;
      case "task.failed":
      case "task.rejected":
      case "task.canceled":
      case "task.retried":
      case "task.escalated":
      case "task.reassigned":
      case "task.requeued":
      case "task.blocked":
        m.taskOutcomes.add(1, { status: event.type.slice("task.".length), agent });
        break;
      case "plan.patched":
        if (event.data.ops.length === 0) m.planPatches.add(1, { op: "policy_rewire", source: event.data.source });
        for (const op of event.data.ops) m.planPatches.add(1, { op: op.op, source: event.data.source });
        break;
      case "guard.tripped":
        m.guardTrips.add(1, { guard: event.data.guard });
        break;
      case "wave.completed":
        m.waveDuration.record(event.data.durationMs / 1000, { progress: String(event.data.progress) });
        break;
      case "run.completed":
        m.runDuration.record(event.data.durationMs / 1000, { status: event.data.status });
        m.runCost.record(event.data.usage.costUsd, { status: event.data.status });
        break;
      default:
        break;
    }
  }
}
