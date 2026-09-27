import { addUsage, emptyUsage, subtractUsage, type Tier, type Usage } from "../common.js";
import type { LifecycleEvent } from "../events.js";
import type { Projection } from "./fold.js";

export type MetricsCounts = {
  dispatched: number;
  completed: number;
  failed: number;
  canceled: number;
  rejected: number;
  retried: number;
  escalated: number;
  reassigned: number;
  requeued: number;
  blocked: number;
  planPatches: number;
  opsRejected: number;
  replans: number;
  proposalsAccepted: number;
  proposalsDeferred: number;
  proposalsDropped: number;
  humanRequests: number;
};

export type MetricsView = {
  usage: Usage;
  byTier: Partial<Record<Tier, Usage>>;
  byModel: Record<string, Usage>;
  counts: MetricsCounts;
  guardTrips: Record<string, number>;
  waves: { wave: number; durationMs: number; reports: number; progress: boolean }[];
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
};

const zeroCounts = (): MetricsCounts => ({
  dispatched: 0,
  completed: 0,
  failed: 0,
  canceled: 0,
  rejected: 0,
  retried: 0,
  escalated: 0,
  reassigned: 0,
  requeued: 0,
  blocked: 0,
  planPatches: 0,
  opsRejected: 0,
  replans: 0,
  proposalsAccepted: 0,
  proposalsDeferred: 0,
  proposalsDropped: 0,
  humanRequests: 0,
});

function withUsage(view: MetricsView, usage: Usage | null, tier: Tier | null, model: string | null): MetricsView {
  if (!usage) return view;
  const byTier = tier ? { ...view.byTier, [tier]: addUsage(view.byTier[tier] ?? emptyUsage(), usage) } : view.byTier;
  const byModel = model ? { ...view.byModel, [model]: addUsage(view.byModel[model] ?? emptyUsage(), usage) } : view.byModel;
  return { ...view, usage: addUsage(view.usage, usage), byTier, byModel };
}

const bump = (view: MetricsView, key: keyof MetricsCounts): MetricsView => ({
  ...view,
  counts: { ...view.counts, [key]: view.counts[key] + 1 },
});

export const metricsProjection: Projection<MetricsView> = {
  name: "metrics",
  init: () => ({
    usage: emptyUsage(),
    byTier: {},
    byModel: {},
    counts: zeroCounts(),
    guardTrips: {},
    waves: [],
    startedAt: null,
    finishedAt: null,
    durationMs: null,
  }),
  apply(view, event: LifecycleEvent) {
    switch (event.type) {
      case "run.started":
        return { ...view, startedAt: view.startedAt ?? event.ts };
      case "intent.analyzed":
      case "plan.created":
        return withUsage(view, event.data.usage, event.data.tier, event.data.model);
      case "replan.completed":
        return bump(withUsage(view, event.data.usage, event.data.tier, event.data.model), "replans");
      case "evaluation.completed": {
        const judge = event.data.judge;
        if (!judge) return withUsage(view, event.data.usage, event.data.tier, event.data.model);
        const agentOnly = subtractUsage(event.data.usage, judge.usage);
        return withUsage(withUsage(view, agentOnly, event.data.tier, event.data.model), judge.usage, judge.tier, judge.model);
      }
      case "run.completed":
        return {
          ...withUsage(view, event.data.synthesisUsage, event.data.tier, event.data.model),
          finishedAt: event.ts,
          durationMs: event.data.durationMs,
        };
      case "task.dispatched":
        return bump(view, "dispatched");
      case "task.completed":
        return bump(view, "completed");
      case "task.failed":
        return bump(view, "failed");
      case "task.canceled":
        return bump(view, "canceled");
      case "task.rejected":
        return bump(view, "rejected");
      case "task.retried":
        return bump(view, "retried");
      case "task.escalated":
        return bump(view, "escalated");
      case "task.reassigned":
        return bump(view, "reassigned");
      case "task.requeued":
        return bump(view, "requeued");
      case "task.blocked":
        return bump(view, "blocked");
      case "plan.patched":
        return bump(view, "planPatches");
      case "plan.op_rejected":
        return bump(view, "opsRejected");
      case "proposal.accepted":
        return bump(view, "proposalsAccepted");
      case "proposal.deferred":
        return bump(view, "proposalsDeferred");
      case "proposal.dropped":
        return bump(view, "proposalsDropped");
      case "human.requested":
        return bump(view, "humanRequests");
      case "guard.tripped":
        return {
          ...view,
          guardTrips: { ...view.guardTrips, [event.data.guard]: (view.guardTrips[event.data.guard] ?? 0) + 1 },
        };
      case "wave.completed":
        return {
          ...view,
          waves: [
            ...view.waves,
            {
              wave: event.data.wave,
              durationMs: event.data.durationMs,
              reports: event.data.reports,
              progress: event.data.progress,
            },
          ],
        };
      default:
        return view;
    }
  },
};
