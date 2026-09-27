import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { API_URL, ASSISTANT_ID } from "../lib/api";
import { setDraft } from "../lib/draft";
import { errorMessage } from "../lib/format";
import { useOrchestratorStream, type OrchestratorStream, type RunOptionsInput } from "../stream/useOrchestratorStream";
import { useCatalogContext } from "./catalog";

export type RunSession = OrchestratorStream & {
  /** A run was submitted from this page and its first events have not arrived yet. */
  starting: boolean;
  /** The query submitted from this page (shown before the server echoes it back). */
  startedQuery: string | null;
  startError: string | null;
  startRun: (query: string, runOptions: RunOptionsInput) => Promise<void>;
  clearStartError: () => void;
};

const SessionContext = createContext<RunSession | null>(null);

/**
 * One stream per mounted session. The shell remounts this provider (new `key`) to open another run, which is the
 * same as today's reload-and-rejoin from the server's point of view and leaves the stream layer untouched.
 */
export function RunSessionProvider({
  initialThreadId,
  onThreadId,
  children,
}: {
  initialThreadId: string | null;
  onThreadId: (threadId: string | null) => void;
  children: ReactNode;
}) {
  const { catalog } = useCatalogContext();
  const stream = useOrchestratorStream({
    apiUrl: API_URL,
    assistantId: ASSISTANT_ID,
    initialThreadId,
    recursionLimit: catalog?.guards.recursionLimit,
    onThreadId,
  });
  const [startedQuery, setStartedQuery] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const { start } = stream;
  const startRun = useCallback(
    async (query: string, runOptions: RunOptionsInput) => {
      setStartError(null);
      setStartedQuery(query);
      try {
        await start(query, runOptions);
      } catch (error) {
        // Back to Home with the draft intact, and say what went wrong.
        setStartedQuery(null);
        setDraft({ query, runOptions });
        setStartError(errorMessage(error));
      }
    },
    [start],
  );

  const clearStartError = useCallback(() => setStartError(null), []);
  const hasEvents = (stream.values.events?.length ?? 0) > 0;
  const starting = startedQuery !== null && !hasEvents && !stream.error;

  const value = useMemo<RunSession>(
    () => ({ ...stream, starting, startedQuery, startError, startRun, clearStartError }),
    [stream, starting, startedQuery, startError, startRun, clearStartError],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useRunSession(): RunSession {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useRunSession must be used inside <RunSessionProvider>");
  return value;
}
