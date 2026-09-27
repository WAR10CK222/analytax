import type { DagEdgeState, DispatchStatus, TaskOriginKind, TaskStatus, Tier, TimelineLevel } from "@analytax/contracts";
import type { CSSProperties } from "react";

/**
 * The single source of label, colour family and icon for every status-like value in the UI.
 * Colour is reserved for meaning: four families plus neutral. Every tone is shown with its icon AND its label.
 */
export type StatusFamily = "running" | "success" | "attention" | "danger" | "neutral";

export type StatusIconKey =
  | "running"
  | "success"
  | "attention"
  | "partial"
  | "danger"
  | "rejected"
  | "neutral"
  | "waiting"
  | "canceled"
  | "stopped"
  | "info"
  | "evaluating";

export type Tone = { readonly label: string; readonly family: StatusFamily; readonly icon: StatusIconKey; readonly color: string };

export const FAMILY_COLOR: Readonly<Record<StatusFamily, string>> = {
  running: "var(--ax-running)",
  success: "var(--ax-success)",
  attention: "var(--ax-attention)",
  danger: "var(--ax-danger)",
  neutral: "var(--ax-fg-3)",
};

const DEFAULT_ICON: Readonly<Record<StatusFamily, StatusIconKey>> = {
  running: "running",
  success: "success",
  attention: "attention",
  danger: "danger",
  neutral: "neutral",
};

export function tone(label: string, family: StatusFamily, icon: StatusIconKey = DEFAULT_ICON[family]): Tone {
  return { label, family, icon, color: FAMILY_COLOR[family] };
}

export const TASK_STATUS_TONE: Readonly<Record<TaskStatus, Tone>> = {
  submitted: tone("Queued", "neutral"),
  working: tone("Running", "running"),
  "input-required": tone("Needs input", "attention"),
  completed: tone("Done", "success"),
  failed: tone("Failed", "danger"),
  canceled: tone("Canceled", "neutral", "canceled"),
  rejected: tone("Rejected", "danger", "rejected"),
};

/** Derived state: submitted but blocked on unfinished dependencies (`isWaiting`). */
export const WAITING_TONE: Tone = tone("Waiting", "neutral", "waiting");

export const SUPERSEDED_TONE: Tone = tone("Replaced", "neutral", "canceled");

export const taskTone = (status: TaskStatus, waiting = false): Tone =>
  waiting && status === "submitted" ? WAITING_TONE : TASK_STATUS_TONE[status];

/** Graph edges: only broken dependencies get colour; done and pending stay neutral. */
export const EDGE_STATE_TONE: Readonly<Record<DagEdgeState, Tone & { readonly dash: string | undefined; readonly stroke: string }>> = {
  satisfied: { ...tone("Done", "neutral", "success"), dash: undefined, stroke: "var(--ax-line-strong)" },
  pending: { ...tone("Pending", "neutral", "waiting"), dash: "5 4", stroke: "var(--ax-line-strong)" },
  broken: { ...tone("Broken", "danger"), dash: "3 4", stroke: "var(--ax-danger)" },
};

export const LEVEL_TONE: Readonly<Record<TimelineLevel, Tone>> = {
  info: tone("Info", "neutral", "info"),
  success: tone("Success", "success"),
  warning: tone("Warning", "attention"),
  error: tone("Error", "danger"),
};

export const DISPATCH_TONE: Readonly<Record<DispatchStatus, Tone>> = {
  queued: tone("Starting", "neutral"),
  running: tone("Running", "running"),
  evaluating: tone("Evaluating", "running", "evaluating"),
  done: tone("Done", "success"),
};

/** Attempt decisions, verdict decisions, human decisions and outcome statuses. */
const DECISION_TONE: Readonly<Record<string, Tone>> = {
  accepted: tone("Accepted", "success"),
  accept: tone("Accepted", "success"),
  completed: tone("Completed", "success"),
  partial: tone("Partial", "attention", "partial"),
  retried: tone("Retried", "attention"),
  revise: tone("Needs revision", "attention"),
  escalated: tone("Escalated", "attention"),
  reassigned: tone("Reassigned", "neutral"),
  requeued: tone("Requeued", "neutral"),
  blocked: tone("Blocked", "attention"),
  declined: tone("Declined", "danger", "rejected"),
  needs_input: tone("Needs input", "attention"),
  input_required: tone("Input required", "attention"),
  failed: tone("Failed", "danger"),
  rejected: tone("Rejected", "danger", "rejected"),
  reject: tone("Rejected", "danger", "rejected"),
  replan_requested: tone("Replan requested", "attention"),
  human_requested: tone("Asked you", "attention"),
  discarded: tone("Discarded", "neutral", "canceled"),
  retry: tone("Retry", "neutral"),
  skip: tone("Skip", "neutral", "canceled"),
  answer: tone("Answer", "success"),
  abort: tone("Abort", "danger"),
  error: tone("Error", "danger"),
};

const humanize = (value: string): string => {
  const spaced = value.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

export function decisionTone(decision: string | null | undefined): Tone {
  if (!decision) return tone("None", "neutral");
  return DECISION_TONE[decision] ?? tone(humanize(decision), "neutral");
}

/** Tasks that did not come from the original plan get a small neutral origin icon. `plan` has none. */
export type OriginIconKey = "proposal" | "split" | "revision" | "replan" | "human" | "fallback" | "direct";

export const ORIGIN_LABEL: Readonly<Partial<Record<TaskOriginKind, { label: string; icon: OriginIconKey; hint: string }>>> = {
  proposal: { label: "Suggested by an agent", icon: "proposal", hint: "Added mid-run from an agent's follow-up or prerequisite" },
  revision: { label: "Revision", icon: "revision", hint: "Redo of a completed task with new instructions" },
  split: { label: "Split", icon: "split", hint: "Part of a task that was broken into smaller ones" },
  replan: { label: "Added by replanning", icon: "replan", hint: "Added when the planner revised the plan" },
  human: { label: "Added by you", icon: "human", hint: "Added during plan review" },
  fallback: { label: "Fallback", icon: "fallback", hint: "Single fallback task after planning failed" },
  direct: { label: "Direct answer", icon: "direct", hint: "Simple question answered by one agent" },
};

export const TIER_LABEL: Readonly<Record<Tier, string>> = {
  fast: "Fast",
  "fast-thinking": "Fast thinking",
  standard: "Standard",
  deep: "Deep",
};

export const humanizeKey = humanize;

/** Inline style that feeds a tone colour to components through `--tone`. */
export function toneStyle(value: Tone | string): CSSProperties {
  return { "--tone": typeof value === "string" ? value : value.color } as CSSProperties;
}
