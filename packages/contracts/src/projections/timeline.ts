import type { LifecycleEvent } from "../events.js";
import type { Projection } from "./fold.js";

export type TimelineLevel = "info" | "success" | "warning" | "error";

export type TimelineEntry = {
  id: string;
  ts: string;
  type: LifecycleEvent["type"];
  level: TimelineLevel;
  title: string;
  detail: string | null;
  taskId: string | null;
  agentId: string | null;
  durability: "durable" | "ephemeral";
};

export type TimelineView = { entries: TimelineEntry[] };

const MAX_ENTRIES = 1000;

type Description = { level: TimelineLevel; title: string; detail: string | null };

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "fast-thinking" -> "fast thinking", "max_waves" -> "max waves". */
const words = (value: string): string => value.replace(/[_-]+/g, " ").trim();

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

const SOURCE_WORDS: Record<string, string> = {
  planner: "the planner",
  replanner: "the replanner",
  proposal: "an agent suggestion",
  policy: "automatic rules",
  human: "you",
};

const DECISION_WORDS: Record<string, string> = {
  accept: "accepted",
  revise: "needs changes",
  reject: "rejected",
  error: "review failed",
  "n/a": "no decision",
};

const REVIEWER_WORDS: Record<string, string> = {
  llm: "Reviewed by a model",
  rules: "Checked by rules",
  skipped: "Review skipped",
  none: "Not reviewed",
};

/**
 * Plain-language one-liners for the activity log. Rows already show the task and agent under the title, so titles
 * never repeat those ids. Returns null for events that don't belong on the log.
 */
export function describeEvent(event: LifecycleEvent): Description | null {
  switch (event.type) {
    case "run.started":
      return { level: "info", title: "Run started", detail: event.data.query };
    case "intent.analyzed":
      return {
        level: "info",
        title: `Request understood: ${words(event.data.intent.intentType)}, ${words(event.data.intent.complexity)} complexity`,
        detail: event.data.intent.goal,
      };
    case "clarification.answered":
      return { level: "info", title: `You answered ${plural(event.data.answers.length, "question")}`, detail: null };
    case "plan.created":
      return {
        level: "info",
        title:
          event.data.path === "direct"
            ? "Planned a direct answer"
            : `Plan created with ${plural(event.data.tasks.length, "task")}${event.data.path === "fallback" ? " (fallback plan)" : ""}`,
        detail: event.data.rationale,
      };
    case "plan.approved":
      return { level: "success", title: event.data.edited ? "You approved the plan with edits" : "You approved the plan", detail: null };
    case "plan.rejected":
      return { level: "warning", title: "You asked for a different plan", detail: event.data.feedback };
    case "plan.patched": {
      const { diff } = event.data;
      const parts = [
        diff.added.length ? `${diff.added.length} added` : "",
        diff.updated.length ? `${diff.updated.length} updated` : "",
        diff.canceled.length ? `${diff.canceled.length} removed` : "",
        diff.rewired.length ? `${diff.rewired.length} rewired` : "",
      ].filter(Boolean);
      return {
        level: "info",
        title: `Plan updated to version ${event.data.version} by ${SOURCE_WORDS[event.data.source] ?? event.data.source}${
          parts.length ? ` (${parts.join(", ")})` : ""
        }`,
        detail: event.data.reason || null,
      };
    }
    case "plan.op_rejected":
      return { level: "warning", title: `A plan change was refused (${words(event.data.op)})`, detail: event.data.errors.join("; ") };
    case "wave.started":
      return { level: "info", title: `Wave ${event.data.wave} started ${plural(event.data.dispatchIds.length, "task")}`, detail: null };
    case "wave.completed":
      return {
        level: event.data.progress ? "info" : "warning",
        title: `Wave ${event.data.wave} finished in ${seconds(event.data.durationMs)}`,
        detail: event.data.progress ? null : `No task finished in this wave (${plural(event.data.stallCount, "stalled wave")} in a row)`,
      };
    case "task.dispatched":
      return {
        level: "info",
        title: event.data.attempt > 1 ? `Started attempt ${event.data.attempt} on the ${words(event.data.tier)} tier` : `Started on the ${words(event.data.tier)} tier`,
        detail: null,
      };
    case "task.completed":
      return { level: "success", title: "Finished", detail: event.data.summary };
    case "task.requeued":
      return { level: "warning", title: "Queued again after a temporary error", detail: event.data.reason };
    case "task.retried":
      return { level: "warning", title: "Retrying with review feedback", detail: event.data.feedback || null };
    case "task.escalated":
      return {
        level: "warning",
        title: `Moved up from the ${words(event.data.fromTier)} tier to the ${words(event.data.toTier)} tier`,
        detail: event.data.reason,
      };
    case "task.reassigned":
      return { level: "warning", title: `Handed from ${event.data.fromAgentId} to ${event.data.toAgentId}`, detail: event.data.reason };
    case "task.blocked":
      return {
        level: "warning",
        title: event.data.prerequisiteTaskId ? "Blocked until a new prerequisite task finishes" : "Blocked",
        detail: event.data.reason,
      };
    case "task.input_required":
      return { level: "warning", title: "Needs your input", detail: event.data.questions.join("; ") };
    case "task.canceled":
      return { level: "warning", title: "Canceled", detail: event.data.reason };
    case "task.failed":
      return { level: "error", title: "Failed", detail: event.data.reason };
    case "task.rejected":
      return { level: "error", title: "Rejected", detail: event.data.reason };
    case "task.report_discarded":
      return { level: "info", title: "Ignored an outdated result", detail: event.data.reason };
    case "evaluation.completed": {
      const decision = event.data.decision ?? (event.data.error ? "error" : "n/a");
      const unmet = event.data.unmetCriteria.length ? `Not met: ${event.data.unmetCriteria.join("; ")}` : null;
      const score = event.data.score === null ? "" : `, score ${event.data.score.toFixed(2)}`;
      return {
        level: decision === "accept" ? "success" : "warning",
        title:
          event.data.evaluatedBy === "skipped" && decision === "accept"
            ? `Accepted without a review${score}`
            : `${REVIEWER_WORDS[event.data.evaluatedBy ?? "none"] ?? "Reviewed"}: ${DECISION_WORDS[decision] ?? decision}${score}`,
        detail: event.data.error ?? unmet,
      };
    }
    case "proposal.accepted":
      return { level: "info", title: `Suggested ${words(event.data.kind)} task added`, detail: event.data.title };
    case "proposal.deferred":
      return { level: "info", title: `Suggested ${words(event.data.kind)} task sent to the replanner`, detail: event.data.title };
    case "proposal.dropped":
      return { level: "warning", title: `Suggested ${words(event.data.kind)} task dropped`, detail: `${event.data.title}: ${event.data.reason}` };
    case "replan.requested":
      return { level: "warning", title: `Replanning (${words(event.data.trigger)})`, detail: event.data.detail };
    case "replan.completed":
      return {
        level: event.data.fallback ? "warning" : "info",
        title: event.data.fallback ? "Replanning fell back to safe defaults" : `Plan revised with ${plural(event.data.applied, "change")}`,
        detail: event.data.diagnosis || null,
      };
    case "guard.tripped":
      return { level: "error", title: `Safety limit reached (${words(event.data.guard)})`, detail: event.data.detail };
    case "human.requested":
      return { level: "warning", title: `Waiting for your review (${plural(event.data.requestIds.length, "request")})`, detail: null };
    case "human.resolved":
      return { level: "info", title: "You finished the review", detail: event.data.decisions.map(words).join(", ") };
    case "synthesis.started":
      return {
        level: "info",
        title: event.data.reason === "complete" ? "Writing the final answer" : `Writing the final answer (${words(event.data.reason)})`,
        detail: `${plural(event.data.completed, "result")}, ${plural(event.data.gaps, "gap")}`,
      };
    case "run.completed":
      return {
        level: event.data.status === "complete" ? "success" : "warning",
        title: event.data.status === "complete" ? `Run completed in ${seconds(event.data.durationMs)}` : `Run finished with a partial answer in ${seconds(event.data.durationMs)}`,
        detail: `${event.data.counts.completed} of ${plural(event.data.counts.total, "task")} completed`,
      };
    case "run.failed":
      return { level: "error", title: "Run failed", detail: event.data.error };
    case "agent.skill.loaded":
      return { level: "info", title: `Loaded the ${event.data.skill} skill`, detail: null };
    default:
      return null;
  }
}

export const timelineProjection: Projection<TimelineView> = {
  name: "timeline",
  init: () => ({ entries: [] }),
  apply(view, event) {
    const description = describeEvent(event);
    if (!description) return view;
    const entry: TimelineEntry = {
      id: event.id,
      ts: event.ts,
      type: event.type,
      ...description,
      taskId: event.taskId,
      agentId: event.agentId,
      durability: event.durability,
    };
    const entries = view.entries.length >= MAX_ENTRIES ? view.entries.slice(1) : view.entries.slice();
    entries.push(entry);
    return { entries };
  },
};
