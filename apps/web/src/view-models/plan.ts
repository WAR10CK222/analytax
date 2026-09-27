import type { OpSourceKind, PlanVersionEntry } from "@analytax/contracts";

export const PLAN_SOURCE_LABEL: Readonly<Record<OpSourceKind, string>> = {
  planner: "Planner",
  replanner: "Replanner",
  proposal: "Agent suggestion",
  policy: "Automatic rule",
  human: "You",
};

export type DiffCounts = { added: number; updated: number; canceled: number; rewired: number };

/** "2 added, 1 rewired" (plain words, no symbols). */
export function describeCounts(counts: DiffCounts): string {
  const parts = [
    counts.added ? `${counts.added} added` : null,
    counts.updated ? `${counts.updated} updated` : null,
    counts.canceled ? `${counts.canceled} removed` : null,
    counts.rewired ? `${counts.rewired} rewired` : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(", ") : "No task changes";
}

export function describeDiff(entry: Pick<PlanVersionEntry, "added" | "updated" | "canceled" | "rewired">): string {
  return describeCounts({ added: entry.added.length, updated: entry.updated.length, canceled: entry.canceled.length, rewired: entry.rewired.length });
}

export type ChangeKind = "added" | "updated" | "rewired";

/**
 * Tasks touched by the focused plan version. The first plan adds every node, so changes only show once the plan
 * has been patched or when the reader pins a version.
 */
export function changedTasks(focus: PlanVersionEntry | null, show: boolean): Map<string, ChangeKind> {
  const map = new Map<string, ChangeKind>();
  if (!focus || !show) return map;
  for (const id of focus.updated) map.set(id, "updated");
  for (const id of focus.rewired) map.set(id, "rewired");
  for (const id of focus.added) map.set(id, "added");
  return map;
}

export const CHANGE_LABEL: Readonly<Record<ChangeKind, string>> = { added: "New", updated: "Updated", rewired: "Rewired" };
