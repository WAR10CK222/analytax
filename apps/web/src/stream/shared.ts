import { HitlInterrupt, isCustomStreamChunk, type CustomStreamChunk, type LifecycleEvent } from "@analytax/contracts";
import { useEffect, useRef, type RefObject } from "react";
import { useEventLogSnapshot, useOrchestrationViews, type EventLog } from "./event-log";
import type { PendingInterrupt, RunOptionsInput } from "./types";

/**
 * Custom-stream payloads arrive either raw (`{ channel, event }`, legacy v1 stream) or wrapped by the
 * Agent Server protocol session as `{ payload: { channel, event } }` (no `name` → channel "custom").
 */
export function extractCustomChunk(data: unknown): CustomStreamChunk | null {
  if (isCustomStreamChunk(data)) return data;
  if (typeof data === "object" && data !== null && "payload" in data) {
    const payload = (data as { payload?: unknown }).payload;
    if (isCustomStreamChunk(payload)) return payload;
  }
  return null;
}

export type RawInterrupt = { id?: string | undefined; value?: unknown };

/** Keeps only interrupts whose value matches the `HitlInterrupt` contract. */
export function toPendingInterrupts(raw: readonly RawInterrupt[] | null | undefined): PendingInterrupt[] {
  if (!Array.isArray(raw)) return [];
  const pending: PendingInterrupt[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || item.value === undefined) continue;
    const parsed = HitlInterrupt.safeParse(item.value);
    if (parsed.success) pending.push({ id: item.id, value: parsed.data });
    else console.warn("[analytax] ignoring interrupt that does not match HitlInterrupt", item.value, parsed.error);
  }
  return pending;
}

/**
 * `respond()` failures a protocol `run.start` can recover from: the Agent Server binds an assistant to a thread only
 * on `run.start` (threads started over HTTP, or joined after a server restart / hot reload, have none), and the
 * controller cannot target an interrupt it never streamed (one picked up by polling the thread).
 */
/** How long a response may go unconfirmed before the UI stops showing "Sending" and checks the server. */
export const RESPOND_TIMEOUT_MS = 20_000;

export class RespondTimeoutError extends Error {
  constructor() {
    super("The orchestrator did not confirm your response within 20 seconds.");
    this.name = "RespondTimeoutError";
  }
}

/**
 * Settles with the promise, or rejects with RespondTimeoutError after `ms`. A command POST can stall in the browser
 * without ever reaching the server (for example when every connection to the API host is held by open event
 * streams), and the SDK has no timeout of its own for it.
 */
export function withRespondTimeout<T>(promise: Promise<T>, ms = RESPOND_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RespondTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const isRespondFallbackError = (error: unknown): boolean =>
  error instanceof Error && /no active assistant|no pending interrupt/i.test(error.message);

/** True while the thread's latest checkpoint still holds an unanswered interrupt (the given one, when an id is passed). */
export async function threadHasPendingInterrupt(apiUrl: string, threadId: string, interruptId?: string): Promise<boolean> {
  const response = await fetch(`${apiUrl}/threads/${encodeURIComponent(threadId)}/state`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) return false;
  const state = (await response.json()) as { tasks?: { interrupts?: { id?: string }[] }[] };
  return (state.tasks ?? []).some((task) =>
    (task.interrupts ?? []).some((interrupt) => interruptId === undefined || interrupt.id === interruptId),
  );
}

export const buildRunInput = (query: string, runOptions: RunOptionsInput) => ({
  messages: [{ type: "human", content: query }],
  runOptions,
});

export const buildRunConfig = (recursionLimit: number | undefined): { recursion_limit?: number } =>
  recursionLimit === undefined ? {} : { recursion_limit: recursionLimit };

export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * Binds an adapter's EventLog to the stream: syncs durable events from `values.events`, resets when the
 * thread changes, reports thread changes, and folds the read models.
 */
export function useEventLogBinding(
  log: EventLog,
  threadId: string | null,
  durableEvents: readonly LifecycleEvent[] | undefined,
  onThreadId: ((threadId: string | null) => void) | undefined,
) {
  const boundThreadId = useRef(threadId);
  const onThreadIdRef = useLatest(onThreadId);

  useEffect(() => {
    if (boundThreadId.current !== threadId) {
      boundThreadId.current = threadId;
      log.reset();
    }
    log.syncDurable(durableEvents);
  }, [log, threadId, durableEvents]);

  useEffect(() => {
    onThreadIdRef.current?.(threadId);
  }, [threadId, onThreadIdRef]);

  const snapshot = useEventLogSnapshot(log);
  const views = useOrchestrationViews(snapshot);
  return { snapshot, views };
}
