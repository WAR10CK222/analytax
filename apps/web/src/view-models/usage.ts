import { activeDispatches, type AgentActivityView, type LedgerView, type MetricsView, type Usage } from "@analytax/contracts";
import { formatCost, formatCount, formatDuration, formatTokens } from "../lib/format";
import { humanizeKey, type StatusFamily } from "../lib/status";

export function liveUsage(activity: AgentActivityView): { tokens: number; costUsd: number } {
  let tokens = 0;
  let costUsd = 0;
  for (const dispatch of activeDispatches(activity)) {
    tokens += dispatch.usage.inputTokens + dispatch.usage.outputTokens;
    costUsd += dispatch.usage.costUsd;
  }
  return { tokens, costUsd };
}

/** The price table ships at zero; show that honestly instead of "$0.00". */
export function costCell(usage: Pick<Usage, "costUsd" | "inputTokens" | "outputTokens">): { text: string; priced: boolean } {
  if (usage.costUsd === 0 && usage.inputTokens + usage.outputTokens > 0) return { text: "Not priced", priced: false };
  return { text: formatCost(usage.costUsd), priced: true };
}

export type Kpi = { id: "duration" | "tokens" | "calls" | "cost"; label: string; value: string; detail: string | null };

export function selectKpis(input: { metrics: MetricsView; live: { tokens: number; costUsd: number }; elapsedMs: number | null }): Kpi[] {
  const { usage } = input.metrics;
  const tokens = usage.inputTokens + usage.outputTokens;
  const cost = costCell(usage);
  const inFlight = input.live.tokens > 0 ? `, ${formatTokens(input.live.tokens)} in flight` : "";
  return [
    { id: "duration", label: "Duration", value: formatDuration(input.metrics.durationMs ?? input.elapsedMs, "Not started"), detail: input.metrics.durationMs === null ? "Still running" : null },
    {
      id: "tokens",
      label: "Tokens",
      value: formatTokens(tokens, "0"),
      detail: `${formatTokens(usage.inputTokens, "0")} in, ${formatTokens(usage.outputTokens, "0")} out, ${formatTokens(usage.reasoningTokens, "0")} thinking${inFlight}`,
    },
    { id: "calls", label: "Model calls", value: formatCount(usage.modelCalls, "0"), detail: `${formatCount(usage.toolCalls, "0")} tool calls` },
    { id: "cost", label: "Cost", value: cost.text, detail: cost.priced ? null : "Add prices in config/models.yaml" },
  ];
}

export type UsageRow = { key: string; usage: Usage; tokens: number; share: number };

export function usageRows(by: Partial<Record<string, Usage>>): UsageRow[] {
  const rows = Object.entries(by)
    .filter((entry): entry is [string, Usage] => entry[1] !== undefined)
    .map(([key, usage]) => ({ key, usage, tokens: usage.inputTokens + usage.outputTokens }));
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  return rows.map((row) => ({ ...row, share: total > 0 ? row.tokens / total : 0 })).sort((a, b) => b.tokens - a.tokens);
}

export type WaveBar = { wave: number; durationMs: number; ratio: number; stalled: boolean; reports: number; label: string };

export function waveBars(waves: MetricsView["waves"]): WaveBar[] {
  const max = waves.reduce((largest, wave) => Math.max(largest, wave.durationMs), 0);
  return waves.map((wave) => ({
    wave: wave.wave,
    durationMs: wave.durationMs,
    ratio: max > 0 ? wave.durationMs / max : 0,
    stalled: !wave.progress,
    reports: wave.reports,
    label: formatDuration(wave.durationMs),
  }));
}

export type CounterItem = { label: string; value: number; family: StatusFamily | null };
export type CounterGroup = { title: string; items: CounterItem[] };

/** Every counter the old metrics bar and header showed, plus the ones that were never shown. */
export function orchestrationCounters(metrics: MetricsView, ledger: LedgerView): CounterGroup[] {
  const c = metrics.counts;
  // ledger.stallCount is the current streak (it resets on progress); the counter shows every stalled wave.
  const stalledWaves = metrics.waves.filter((wave) => !wave.progress).length;
  const warn = (value: number): StatusFamily | null => (value > 0 ? "attention" : null);
  const bad = (value: number): StatusFamily | null => (value > 0 ? "danger" : null);
  return [
    {
      title: "Tasks",
      items: [
        { label: "Dispatched", value: c.dispatched, family: null },
        { label: "Completed", value: c.completed, family: c.completed > 0 ? "success" : null },
        { label: "Failed", value: c.failed, family: bad(c.failed) },
        { label: "Rejected", value: c.rejected, family: bad(c.rejected) },
        { label: "Canceled", value: c.canceled, family: null },
      ],
    },
    {
      title: "Recovery",
      items: [
        { label: "Retried", value: c.retried, family: warn(c.retried) },
        { label: "Moved to a stronger model", value: c.escalated, family: warn(c.escalated) },
        { label: "Reassigned", value: c.reassigned, family: warn(c.reassigned) },
        { label: "Requeued after errors", value: c.requeued, family: warn(c.requeued) },
        { label: "Blocked", value: c.blocked, family: warn(c.blocked) },
      ],
    },
    {
      title: "Plan changes",
      items: [
        { label: "Replans", value: c.replans, family: warn(c.replans) },
        { label: "Plan patches", value: c.planPatches, family: null },
        { label: "Suggestions accepted", value: c.proposalsAccepted, family: null },
        { label: "Suggestions deferred", value: c.proposalsDeferred, family: null },
        { label: "Suggestions dropped", value: c.proposalsDropped, family: null },
        { label: "Changes rejected by validation", value: c.opsRejected, family: warn(c.opsRejected) },
      ],
    },
    {
      title: "Run",
      items: [
        { label: "Waves", value: ledger.wave, family: null },
        { label: "Waves without progress", value: stalledWaves, family: warn(stalledWaves) },
        { label: "Questions asked", value: c.humanRequests, family: null },
      ],
    },
  ];
}

export function guardTrips(ledger: LedgerView): { guard: string; label: string; detail: string; ts: string }[] {
  return ledger.guards.map((trip) => ({ guard: trip.guard, label: humanizeKey(trip.guard), detail: trip.detail, ts: trip.ts }));
}
