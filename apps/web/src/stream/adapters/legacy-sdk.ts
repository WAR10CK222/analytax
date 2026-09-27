import { useStream } from "@langchain/langgraph-sdk/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EventLog } from "../event-log";
import { buildRunConfig, buildRunInput, extractCustomChunk, useEventLogBinding, useLatest } from "../shared";
import { cancelActiveRuns, useThreadSync } from "../thread-sync";
import type { OrchestratorStream, OrchestratorStreamOptions, OrchestratorValues, RunOptionsInput } from "../types";

type LegacyBag = {
  ConfigurableType: Record<string, unknown>;
  InterruptType: unknown;
  CustomEventType: unknown;
  UpdateType: Record<string, unknown>;
};

type PendingStart = { query: string; runOptions: RunOptionsInput };

/**
 * Adapter over the legacy `@langchain/langgraph-sdk/react` hook (v1 run streams).
 *
 * - Custom events: `onCustomEvent(data)` receives the writer chunk (`{ channel, event }`); providing the
 *   callback adds the "custom" stream mode. We also request it explicitly on every submit.
 * - Interrupts: `stream.interrupts` (from `values.__interrupt__` or the thread head's tasks). Resume with
 *   `submit(null, { command: { resume } })`.
 * - Reload: `reconnectOnMount` stores the run id in sessionStorage and re-joins the run; the thread state is
 *   fetched with `fetchStateHistory: { limit: 1 }` (latest checkpoint only, refetched when a run finishes).
 * - Freshness: the hook only streams runs it started or rejoined, so `useThreadSync` polls the thread and takes
 *   over values, interrupts and the running state for runs started elsewhere.
 */
export function useLegacySdkStream(options: OrchestratorStreamOptions): OrchestratorStream {
  const optionsRef = useLatest(options);
  const [threadId, setThreadId] = useState<string | null>(options.initialThreadId);
  const [pendingStart, setPendingStart] = useState<PendingStart | null>(null);
  const [log] = useState(() => new EventLog());

  const stream = useStream<Record<string, unknown>, LegacyBag>({
    apiUrl: options.apiUrl,
    assistantId: options.assistantId,
    threadId,
    onThreadId: setThreadId,
    messagesKey: "messages",
    reconnectOnMount: true,
    // A numeric limit (not `false`) makes the hook refetch the thread head after each run; otherwise
    // `interrupts` falls back to the stale head and keeps showing already-answered interrupts.
    fetchStateHistory: { limit: 1 },
    onCustomEvent: (data) => {
      const chunk = extractCustomChunk(data);
      if (chunk) log.pushLive(chunk.event);
    },
  });
  const streamRef = useLatest(stream);
  const threadIdRef = useLatest(threadId);

  const sync = useThreadSync({
    apiUrl: options.apiUrl,
    threadId,
    values: stream.values as OrchestratorValues | null | undefined,
    interrupts: stream.interrupts,
    isStreaming: stream.isLoading || pendingStart !== null,
  });
  const syncRef = useLatest(sync);
  const { values, interrupts, externalRunActive } = sync;
  const { snapshot, views } = useEventLogBinding(log, threadId, values.events, options.onThreadId);

  // A run must start on a fresh thread: detach first, then submit once the hook has rendered with no thread
  // (its submit closure creates the thread when `threadId` is null).
  useEffect(() => {
    if (!pendingStart || threadId !== null) return;
    setPendingStart(null);
    void streamRef.current.submit(buildRunInput(pendingStart.query, pendingStart.runOptions), {
      config: buildRunConfig(optionsRef.current.recursionLimit),
      streamMode: ["values", "custom"],
    });
  }, [pendingStart, threadId, streamRef, optionsRef]);

  const start = useCallback(
    async (query: string, runOptions: RunOptionsInput) => {
      log.reset();
      setThreadId(null);
      setPendingStart({ query, runOptions });
    },
    [log],
  );

  const respond = useCallback(
    // Our graph pauses on one interrupt at a time, so a plain resume value targets it; the id is not needed.
    async (value: unknown, _interruptId?: string) => {
      try {
        await streamRef.current.submit(null, {
          command: { resume: value },
          config: buildRunConfig(optionsRef.current.recursionLimit),
          streamMode: ["values", "custom"],
        });
      } finally {
        syncRef.current.refresh();
      }
    },
    [optionsRef, streamRef, syncRef],
  );

  const stop = useCallback(async () => {
    const stream = streamRef.current;
    const currentThreadId = threadIdRef.current;
    if (stream.isLoading) await stream.stop();
    else if (syncRef.current.externalRunActive && currentThreadId) {
      await cancelActiveRuns(optionsRef.current.apiUrl, currentThreadId);
    }
    syncRef.current.refresh();
  }, [optionsRef, streamRef, syncRef, threadIdRef]);

  const reset = useCallback(() => {
    log.reset();
    setPendingStart(null);
    setThreadId(null);
  }, [log]);

  return useMemo(
    () => ({
      sdk: "legacy" as const,
      threadId,
      values,
      views,
      liveEvents: snapshot.live,
      interrupts,
      isLoading: stream.isLoading || pendingStart !== null || externalRunActive,
      isThreadLoading: stream.isThreadLoading,
      threadStatus: sync.threadStatus,
      error: stream.error,
      start,
      respond,
      stop,
      reset,
    }),
    [
      threadId,
      values,
      views,
      snapshot.live,
      interrupts,
      stream.isLoading,
      pendingStart,
      externalRunActive,
      stream.isThreadLoading,
      sync.threadStatus,
      stream.error,
      start,
      respond,
      stop,
      reset,
    ],
  );
}
