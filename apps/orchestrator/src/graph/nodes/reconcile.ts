import { reconcile } from "../../control/reconcile.js";
import { recordDurableEvents } from "../../telemetry/metrics.js";
import { withSpan } from "../../telemetry/tracing.js";
import { truncate } from "../../util/text.js";
import type { OrchestratorDeps } from "../deps.js";
import type { State, Update } from "../state.js";

/** Thin graph adapter around the pure control kernel. Safe to re-run (deterministic function of state). */
export function createReconcileNode(deps: OrchestratorDeps) {
  return async (state: State): Promise<Update> =>
    withSpan("orchestrator.reconcile", { parent: state.run.traceparent, attributes: { "analytax.node": "reconcile" } }, async (span) => {
      const output = reconcile(state, {
        agents: deps.agents,
        config: deps.config,
        now: () => deps.clock.now(),
        resolveModel: (tier) => deps.models.resolve(tier),
      });
      span.setAttributes({
        "analytax.route": output.route.kind,
        "analytax.wave": output.control.wave,
        "analytax.reports": output.ack.length,
        "analytax.events": output.events.length,
      });
      for (const event of output.events) {
        if (event.type === "plan.patched" || event.type === "guard.tripped" || event.type === "replan.requested") {
          span.addEvent(event.type, { data: truncate(JSON.stringify(event.data), 1000) });
        }
      }
      recordDurableEvents(output.events);
      return {
        tasks: output.tasks,
        results: output.results,
        inbox: { ack: output.ack },
        control: output.control,
        events: output.events,
        ...(output.plan ? { plan: output.plan } : {}),
      };
    });
}
