import { formatToolName, unwrapToolOutput, type LifecycleEvent, type TimelineEntry } from "@analytax/contracts";
import { plainThought } from "./dispatch";

export type ActivityFilter = "all" | "decisions" | "tasks" | "issues";
export type ActivityCategory = "decision" | "task" | "agent_step" | "run";

const DECISION_PREFIXES = ["plan.", "replan.", "human.", "clarification.", "proposal.", "guard."];

export function entryCategory(entry: TimelineEntry): ActivityCategory {
  if (entry.durability === "ephemeral" || entry.type.startsWith("agent.")) return "agent_step";
  if (DECISION_PREFIXES.some((prefix) => entry.type.startsWith(prefix))) return "decision";
  if (entry.type.startsWith("task.") || entry.type.startsWith("evaluation.")) return "task";
  return "run";
}

export const isWaveMarker = (entry: TimelineEntry): boolean => entry.type === "wave.started";

function matches(entry: TimelineEntry, filter: ActivityFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "decisions":
      return entryCategory(entry) === "decision";
    case "tasks":
      return entryCategory(entry) === "task";
    case "issues":
      return entry.level === "warning" || entry.level === "error";
  }
}

/** Newest first, filtered; agent steps only when asked for. Wave markers stay as separators. */
export function selectActivity(
  entries: readonly TimelineEntry[],
  options: { filter: ActivityFilter; taskId: string | null; showAgentSteps: boolean; limit?: number },
): TimelineEntry[] {
  const { filter, taskId, showAgentSteps, limit = 600 } = options;
  const out: TimelineEntry[] = [];
  for (let index = entries.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const entry = entries[index]!;
    if (!showAgentSteps && entryCategory(entry) === "agent_step") continue;
    if (taskId && entry.taskId !== taskId && !isWaveMarker(entry)) continue;
    if (isWaveMarker(entry)) {
      if (filter === "all" && !taskId) out.push(entry);
      continue;
    }
    if (matches(entry, filter)) out.push(entry);
  }
  // Drop a wave marker that ends up with nothing under it (newest first: a marker follows its entries).
  return out.filter((entry, index) => !isWaveMarker(entry) || (index > 0 && !isWaveMarker(out[index - 1]!)));
}

export function activityCounts(entries: readonly TimelineEntry[], taskId: string | null, showAgentSteps: boolean): Record<ActivityFilter, number> {
  const counts: Record<ActivityFilter, number> = { all: 0, decisions: 0, tasks: 0, issues: 0 };
  for (const entry of entries) {
    if (isWaveMarker(entry)) continue;
    if (!showAgentSteps && entryCategory(entry) === "agent_step") continue;
    if (taskId && entry.taskId !== taskId) continue;
    counts.all += 1;
    if (matches(entry, "decisions")) counts.decisions += 1;
    if (matches(entry, "tasks")) counts.tasks += 1;
    if (matches(entry, "issues")) counts.issues += 1;
  }
  return counts;
}

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * Tool calls and thoughts from the live stream as log rows. They exist only while the page watches the run live
 * (the durable timeline keeps just skill loads).
 */
export function liveStepEntries(live: readonly LifecycleEvent[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const event of live) {
    const common = { id: event.id, ts: event.ts, type: event.type, taskId: event.taskId, agentId: event.agentId, durability: "ephemeral" as const };
    if (event.type === "agent.tool.finished") {
      out.push({
        ...common,
        level: event.data.ok ? "info" : "warning",
        title: `${event.data.ok ? "Used" : "Tool failed:"} ${formatToolName(event.data.tool)}`,
        detail: event.data.preview ? truncate(unwrapToolOutput(event.data.preview), 400) : null,
      });
    } else if (event.type === "agent.thought") {
      out.push({ ...common, level: "info", title: "Thinking", detail: truncate(plainThought(event.data.text), 600) });
    }
  }
  return out;
}

/** Merge durable timeline entries with live steps, oldest first. */
export function mergeEntries(durable: readonly TimelineEntry[], steps: readonly TimelineEntry[]): TimelineEntry[] {
  if (steps.length === 0) return [...durable];
  const ids = new Set(durable.map((entry) => entry.id));
  return [...durable, ...steps.filter((entry) => !ids.has(entry.id))].sort((a, b) => a.ts.localeCompare(b.ts));
}
