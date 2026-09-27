import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toPendingInterrupts, type RawInterrupt } from "./shared";
import type { OrchestratorValues, PendingInterrupt } from "./types";

/**
 * Keeps the view on the thread's latest state when the SDK stream falls behind it:
 * - `@langchain/react` streams only runs started through its own protocol session. Runs started over the plain HTTP
 *   API (Studio, scripts, another client) never reach it, and a reload mid-run can replay that session's buffered
 *   events on top of the freshly hydrated state.
 * - The legacy hook streams only runs it started or rejoined.
 * The hook polls the thread's checkpoint state and run list, and uses that snapshot whenever it is ahead of what the
 * stream shows. (`GET /threads/{id}` is not enough: the Agent Server does not update its status or values for
 * protocol-started runs.)
 */

export type ThreadStatus = "idle" | "busy" | "interrupted" | "error";

type ThreadSnapshot = {
  threadId: string;
  status: ThreadStatus;
  /** Id of the checkpoint the snapshot was read from; changes whenever the graph writes state. */
  checkpointId: string;
  fetchedAt: number;
  values: OrchestratorValues;
  interrupts: RawInterrupt[];
};

type StateResponse = {
  values?: OrchestratorValues | null;
  next?: string[];
  tasks?: { interrupts?: RawInterrupt[] }[];
  checkpoint?: { checkpoint_id?: string } | null;
};

type RunResponse = { run_id: string; status: string };

/** Poll delays (ms): fast while a run the SDK is not streaming is active, slow when there is nothing to catch up on. */
const POLL_MS = { external: 1500, streaming: 5000, interrupted: 3000, idle: 8000, hidden: 15000 } as const;

const EMPTY_VALUES: OrchestratorValues = {};

const JSON_HEADERS = { accept: "application/json" };

const isActiveRun = (run: RunResponse): boolean => run.status === "pending" || run.status === "running";

/** Highest durable event sequence in a state snapshot (-1 when there are none). */
export function lastEventSeq(values: OrchestratorValues | null | undefined): number {
  const events = values?.events;
  if (!Array.isArray(events) || events.length === 0) return -1;
  return events.at(-1)?.seq ?? events.length;
}

const interruptKey = (interrupts: readonly RawInterrupt[] | null | undefined): string =>
  (interrupts ?? [])
    .map((interrupt) => interrupt.id ?? "")
    .sort()
    .join("|");

async function fetchThread(apiUrl: string, threadId: string, signal: AbortSignal): Promise<ThreadSnapshot | null> {
  const base = `${apiUrl}/threads/${encodeURIComponent(threadId)}`;
  const [stateResponse, runsResponse] = await Promise.all([
    fetch(`${base}/state`, { signal, headers: JSON_HEADERS }),
    fetch(`${base}/runs?limit=10`, { signal, headers: JSON_HEADERS }),
  ]);
  // A thread this page just created does not exist server-side until its first run is accepted.
  if (stateResponse.status === 404) return null;
  if (!stateResponse.ok) throw new Error(`Thread state request failed: HTTP ${stateResponse.status}`);
  const state = (await stateResponse.json()) as StateResponse;
  const runs = runsResponse.ok ? ((await runsResponse.json()) as RunResponse[]) : [];
  const interrupts = (state.tasks ?? []).flatMap((task) => task.interrupts ?? []);
  const status: ThreadStatus = runs.some(isActiveRun)
    ? "busy"
    : interrupts.length > 0
      ? "interrupted"
      : (state.next?.length ?? 0) > 0
        ? "error"
        : "idle";
  return {
    threadId,
    status,
    checkpointId: state.checkpoint?.checkpoint_id ?? "",
    fetchedAt: Date.now(),
    values: state.values ?? EMPTY_VALUES,
    interrupts,
  };
}

/** Cancels the thread's pending or running runs over HTTP; the SDKs can only stop runs they stream themselves. */
export async function cancelActiveRuns(apiUrl: string, threadId: string): Promise<void> {
  const base = `${apiUrl}/threads/${encodeURIComponent(threadId)}/runs`;
  const response = await fetch(`${base}?limit=20`, { headers: JSON_HEADERS });
  if (!response.ok) throw new Error(`Run list request failed: HTTP ${response.status}`);
  const runs = (await response.json()) as RunResponse[];
  await Promise.all(
    runs.filter(isActiveRun).map(async (run) => {
      const cancel = await fetch(`${base}/${encodeURIComponent(run.run_id)}/cancel`, { method: "POST" });
      if (!cancel.ok && cancel.status !== 404) throw new Error(`Cancel request failed: HTTP ${cancel.status}`);
    }),
  );
}

export type ThreadSyncOptions = {
  apiUrl: string;
  threadId: string | null;
  /** State as the SDK stream currently reports it. */
  values: OrchestratorValues | null | undefined;
  interrupts: readonly RawInterrupt[] | null | undefined;
  /** True while the SDK itself streams a run on this thread. */
  isStreaming: boolean;
};

export type ThreadSync = {
  values: OrchestratorValues;
  interrupts: PendingInterrupt[];
  /** A run is active on the thread that the SDK is not streaming (started elsewhere, or joined after a reload). */
  externalRunActive: boolean;
  /** Server-side thread status from the last poll; null until the first poll returns. */
  threadStatus: ThreadStatus | null;
  /** Polls right away, e.g. after this page sent a command. */
  refresh: () => void;
};

export function useThreadSync({ apiUrl, threadId, values, interrupts, isStreaming }: ThreadSyncOptions): ThreadSync {
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const streamingRef = useRef(isStreaming);
  streamingRef.current = isStreaming;
  const pollNowRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!threadId) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let status: ThreadStatus | null = null;
    let inFlight = false;
    let pollAgain = false;

    const schedule = () => {
      const delay = document.hidden
        ? POLL_MS.hidden
        : status === "busy"
          ? streamingRef.current
            ? POLL_MS.streaming
            : POLL_MS.external
          : status === "interrupted"
            ? POLL_MS.interrupted
            : POLL_MS.idle;
      timer = setTimeout(() => void poll(), delay);
    };

    const poll = async () => {
      if (inFlight) {
        pollAgain = true;
        return;
      }
      clearTimeout(timer);
      inFlight = true;
      try {
        const next = await fetchThread(apiUrl, threadId, controller.signal);
        if (controller.signal.aborted) return;
        status = next?.status ?? null;
        // Keep the previous object when nothing changed so consumers do not re-render on every poll.
        setSnapshot((previous) =>
          previous &&
          next &&
          previous.threadId === next.threadId &&
          previous.checkpointId === next.checkpointId &&
          previous.status === next.status
            ? previous
            : next,
        );
      } catch {
        // Network hiccup or abort: keep the last snapshot and try again on the next tick.
      } finally {
        inFlight = false;
      }
      if (controller.signal.aborted) return;
      if (pollAgain) {
        pollAgain = false;
        void poll();
      } else {
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (!document.hidden) void poll();
    };
    pollNowRef.current = () => void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
      pollNowRef.current = () => undefined;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [apiUrl, threadId]);

  // A run this page streamed just ended: the last snapshot may still say "busy".
  const wasStreamingRef = useRef(isStreaming);
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) pollNowRef.current();
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  const streamSeq = lastEventSeq(values);
  const streamInterruptKey = interruptKey(interrupts);
  // When the stream last changed; lets an equally-sequenced but newer snapshot win (e.g. an interrupt answered elsewhere).
  const streamMark = useRef({ seq: streamSeq, key: streamInterruptKey, at: Date.now() });
  if (streamMark.current.seq !== streamSeq || streamMark.current.key !== streamInterruptKey) {
    streamMark.current = { seq: streamSeq, key: streamInterruptKey, at: Date.now() };
  }

  const current = snapshot !== null && snapshot.threadId === threadId ? snapshot : null;
  const serverSeq = lastEventSeq(current?.values);
  const server =
    current !== null &&
    (serverSeq > streamSeq ||
      (serverSeq === streamSeq &&
        !isStreaming &&
        current.fetchedAt > streamMark.current.at &&
        interruptKey(current.interrupts) !== streamInterruptKey))
      ? current
      : null;

  const chosenValues = server ? server.values : (values ?? EMPTY_VALUES);
  const chosenInterrupts = server ? server.interrupts : interrupts;
  const pending = useMemo(() => toPendingInterrupts(chosenInterrupts), [chosenInterrupts]);
  const threadStatus = current?.status ?? null;
  const externalRunActive = threadStatus === "busy" && !isStreaming;
  const refresh = useCallback(() => pollNowRef.current(), []);

  return useMemo(
    () => ({ values: chosenValues, interrupts: pending, externalRunActive, threadStatus, refresh }),
    [chosenValues, pending, externalRunActive, threadStatus, refresh],
  );
}
