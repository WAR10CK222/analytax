import { useSyncExternalStore } from "react";
import { z } from "zod";
import { readStorage, writeStorage } from "./storage";

/**
 * Runs this browser started or opened, newest first. The Agent Server can list threads, but threads started through
 * the streaming protocol carry no values on the thread record, so titles and outcomes are kept here.
 */
export const RUN_HISTORY_KEY = "analytax.runs.v1";
export const RUN_HISTORY_LIMIT = 50;

export const HistoryStatus = z.enum(["starting", "running", "needs_input", "completed", "partial", "failed", "stopped", "idle", "missing"]);
export type HistoryStatus = z.infer<typeof HistoryStatus>;

export const RunHistoryEntry = z.object({
  threadId: z.string().min(1),
  query: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: HistoryStatus,
});
export type RunHistoryEntry = z.infer<typeof RunHistoryEntry>;

export function parseHistory(raw: string | null): RunHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed = z.array(z.unknown()).parse(JSON.parse(raw));
    return parsed.flatMap((item) => {
      const entry = RunHistoryEntry.safeParse(item);
      return entry.success ? [entry.data] : [];
    });
  } catch {
    return [];
  }
}

export type RunHistoryPatch = Pick<RunHistoryEntry, "threadId"> &
  Partial<Omit<RunHistoryEntry, "threadId" | "createdAt" | "updatedAt">> & {
    /** When the run last did something (its last event). Without it, a change is stamped with the current time. */
    activityAt?: string | null;
  };

const byActivity = (a: RunHistoryEntry, b: RunHistoryEntry): number => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

/**
 * Inserts or updates one run and keeps the list ordered by last activity and bounded. Opening an old run does not move
 * it, because its time comes from the run itself. Returns the same array when nothing changed.
 */
export function upsertRun(list: readonly RunHistoryEntry[], patch: RunHistoryPatch, nowIso: string): RunHistoryEntry[] {
  const index = list.findIndex((entry) => entry.threadId === patch.threadId);
  if (index >= 0) {
    const current = list[index]!;
    const query = patch.query ?? current.query;
    const status = patch.status ?? current.status;
    const changed = query !== current.query || status !== current.status;
    const updatedAt = patch.activityAt ?? (changed ? nowIso : current.updatedAt);
    if (!changed && updatedAt === current.updatedAt) return list as RunHistoryEntry[];
    const next = list.slice();
    next[index] = { ...current, query, status, updatedAt };
    return next.sort(byActivity);
  }
  const created: RunHistoryEntry = {
    threadId: patch.threadId,
    query: patch.query ?? null,
    status: patch.status ?? "running",
    createdAt: nowIso,
    updatedAt: patch.activityAt ?? nowIso,
  };
  return [created, ...list].sort(byActivity).slice(0, RUN_HISTORY_LIMIT);
}

export function removeRun(list: readonly RunHistoryEntry[], threadId: string): RunHistoryEntry[] {
  return list.filter((entry) => entry.threadId !== threadId);
}

// ---------------------------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------------------------

const listeners = new Set<() => void>();
let snapshot: RunHistoryEntry[] = typeof window === "undefined" ? [] : parseHistory(readStorage(RUN_HISTORY_KEY));

function commit(next: RunHistoryEntry[]): void {
  if (next === snapshot) return;
  snapshot = next;
  writeStorage(RUN_HISTORY_KEY, JSON.stringify(next));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== RUN_HISTORY_KEY) return;
    snapshot = parseHistory(event.newValue);
    for (const each of listeners) each();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export const runHistoryStore = {
  subscribe,
  getSnapshot: (): RunHistoryEntry[] => snapshot,
  upsert: (patch: RunHistoryPatch) => commit(upsertRun(snapshot, patch, new Date().toISOString())),
  remove: (threadId: string) => commit(removeRun(snapshot, threadId)),
  clear: () => commit([]),
};

const EMPTY: RunHistoryEntry[] = [];

export function useRunHistory(): RunHistoryEntry[] {
  return useSyncExternalStore(runHistoryStore.subscribe, runHistoryStore.getSnapshot, () => EMPTY);
}
