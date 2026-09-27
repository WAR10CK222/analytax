import { STREAM_CONTROLLER, useChannelEffect, useStream, type Channel, type Event } from "@langchain/react";
import { useCallback, useMemo, useState } from "react";
import { EventLog } from "../event-log";
import {
  buildRunConfig,
  buildRunInput,
  extractCustomChunk,
  isRespondFallbackError,
  RespondTimeoutError,
  threadHasPendingInterrupt,
  withRespondTimeout,
  useEventLogBinding,
  useLatest,
} from "../shared";
import { cancelActiveRuns, useThreadSync } from "../thread-sync";
import type { OrchestratorStream, OrchestratorStreamOptions, OrchestratorValues, RunOptionsInput } from "../types";

const CUSTOM_CHANNELS: readonly Channel[] = ["custom"];

/**
 * Adapter over `@langchain/react` (protocol v2 stream controller).
 *
 * - Custom events: `useChannelEffect(stream, ["custom"])` delivers protocol events
 *   `{ method: "custom", params: { namespace, timestamp, data } }`. The Agent Server wraps a writer chunk
 *   without `name` as `data = { payload: chunk }`, so we read `data.payload ?? data` and validate it with
 *   `isCustomStreamChunk`. Worker nodes write at the root namespace, which the root-scoped effect covers.
 * - Interrupts: `stream.interrupts` (seeded on hydration, updated from `input.requested` events), resumed
 *   with `stream.respond(value, { interruptId, config })`. Threads the server has no assistant bound to (started
 *   over HTTP, or joined after a server restart) refuse `input.respond`; those resume through `submit` instead.
 * - Freshness: the protocol session only streams runs it started itself, so `useThreadSync` polls the thread and
 *   takes over values, interrupts and the running state whenever the server is ahead (runs started elsewhere,
 *   reloads mid-run). Such runs show durable progress only; their live agent activity is not streamed.
 * - New runs always target a new thread via `submit(..., { threadId: null })`.
 */
export function useLangchainReactStream(options: OrchestratorStreamOptions): OrchestratorStream {
  const optionsRef = useLatest(options);
  // The prop only seeds the controller with the thread from the URL. Later switches go through the controller
  // so a self-created thread id is never echoed back as a prop (which would re-hydrate mid-run).
  const [seedThreadId] = useState(options.initialThreadId);
  const [log] = useState(() => new EventLog());

  const stream = useStream<Record<string, unknown>>({
    apiUrl: options.apiUrl,
    assistantId: options.assistantId,
    threadId: seedThreadId,
    messagesKey: "messages",
  });
  const streamRef = useLatest(stream);

  const sync = useThreadSync({
    apiUrl: options.apiUrl,
    threadId: stream.threadId,
    values: stream.values as OrchestratorValues,
    interrupts: stream.interrupts,
    isStreaming: stream.isLoading,
  });
  const syncRef = useLatest(sync);
  const { values, interrupts, externalRunActive } = sync;
  const { snapshot, views } = useEventLogBinding(log, stream.threadId, values.events, options.onThreadId);

  useChannelEffect(stream, CUSTOM_CHANNELS, {
    onEvent: (event: Event) => {
      if (event.method !== "custom") return;
      const chunk = extractCustomChunk(event.params.data);
      if (chunk) log.pushLive(chunk.event);
    },
  });

  const start = useCallback(
    async (query: string, runOptions: RunOptionsInput) => {
      log.reset();
      await streamRef.current.submit(buildRunInput(query, runOptions), {
        config: buildRunConfig(optionsRef.current.recursionLimit),
        threadId: null,
      });
    },
    [log, optionsRef, streamRef],
  );

  const respond = useCallback(
    async (value: unknown, interruptId?: string) => {
      const stream = streamRef.current;
      const config = buildRunConfig(optionsRef.current.recursionLimit);
      try {
        await withRespondTimeout(stream.respond(value, interruptId ? { interruptId, config } : { config }));
      } catch (error) {
        if (error instanceof RespondTimeoutError) {
          // Unconfirmed is not the same as lost: if the interrupt is gone, the response did land.
          const threadId = stream.threadId;
          if (threadId && !(await threadHasPendingInterrupt(optionsRef.current.apiUrl, threadId, interruptId))) return;
          throw new Error(`${error.message} Try again. If it keeps happening, reload the page to reset the connection.`);
        }
        // On an interrupted thread the server turns `run.start` input into `Command({ resume: input })` and binds
        // the assistant, so fall back to it — only while the interrupt is still pending, or it would start a new run.
        const threadId = stream.threadId;
        if (!isRespondFallbackError(error) || !threadId) throw error;
        if (!(await threadHasPendingInterrupt(optionsRef.current.apiUrl, threadId, interruptId))) throw error;
        const resume = interruptId ? { [interruptId]: value } : value;
        await stream.submit(resume as Record<string, unknown>, { config });
      } finally {
        syncRef.current.refresh();
      }
    },
    [optionsRef, streamRef, syncRef],
  );

  const stop = useCallback(async () => {
    const stream = streamRef.current;
    if (stream.isLoading) await stream.stop();
    else if (syncRef.current.externalRunActive && stream.threadId) {
      await cancelActiveRuns(optionsRef.current.apiUrl, stream.threadId);
    }
    syncRef.current.refresh();
  }, [optionsRef, streamRef, syncRef]);

  const reset = useCallback(() => {
    log.reset();
    void streamRef.current[STREAM_CONTROLLER].hydrate(null);
  }, [log, streamRef]);

  return useMemo(
    () => ({
      sdk: "react" as const,
      threadId: stream.threadId,
      values,
      views,
      liveEvents: snapshot.live,
      interrupts,
      isLoading: stream.isLoading || externalRunActive,
      isThreadLoading: stream.isThreadLoading,
      threadStatus: sync.threadStatus,
      error: stream.error,
      start,
      respond,
      stop,
      reset,
    }),
    [
      stream.threadId,
      values,
      views,
      snapshot.live,
      interrupts,
      stream.isLoading,
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
