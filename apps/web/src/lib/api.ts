import { CatalogResponse, McpServerSummary, McpStatus } from "@analytax/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

const trimTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

export const API_URL = trimTrailingSlash(import.meta.env.VITE_LANGGRAPH_API_URL?.trim() || "http://localhost:2024");

/** Unset → local otel-lgtm Grafana; set to an empty string to hide trace links. */
export const GRAFANA_URL = trimTrailingSlash((import.meta.env.VITE_GRAFANA_URL ?? "http://localhost:3000").trim());

/** Graph id registered in apps/orchestrator/langgraph.json. */
export const ASSISTANT_ID = "orchestrator";

export async function fetchCatalog(signal?: AbortSignal): Promise<CatalogResponse> {
  const response = await fetch(`${API_URL}/analytax/catalog`, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Catalog request failed: HTTP ${response.status} ${response.statusText}`.trim());
  const body: unknown = await response.json();
  const parsed = CatalogResponse.safeParse(body);
  if (!parsed.success) throw new Error(`Catalog response does not match the contract:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

async function getJson<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { ...init, headers: { accept: "application/json", ...init?.headers } });
  if (!response.ok) throw new Error(`Request failed: HTTP ${response.status} ${response.statusText}`.trim());
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new Error(`Response does not match the contract:
${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Current MCP tool server status (the server reports its last known state; no connection attempts). */
export const fetchMcpStatus = (signal?: AbortSignal): Promise<McpStatus> => getJson("/analytax/mcp", McpStatus, { signal });

/** Asks the orchestrator to connect to one MCP server now, skipping its retry wait. */
export const reconnectMcp = (id: string): Promise<McpServerSummary> =>
  getJson(`/analytax/mcp/${encodeURIComponent(id)}/reconnect`, McpServerSummary, { method: "POST" });

export type CatalogState = {
  catalog: CatalogResponse | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
};

const CATALOG_RETRY_MS = 5000;

export function useCatalog(): CatalogState {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const quietRetry = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    if (!quietRetry.current) setLoading(true);
    quietRetry.current = false;
    fetchCatalog(controller.signal)
      .then((data) => {
        setCatalog(data);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);

  // While the orchestrator is unreachable, keep retrying quietly so the app recovers once it starts.
  useEffect(() => {
    if (!error) return;
    const retry = () => {
      quietRetry.current = true;
      setAttempt((value) => value + 1);
    };
    const timer = window.setTimeout(retry, CATALOG_RETRY_MS);
    window.addEventListener("focus", retry);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", retry);
    };
  }, [error, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { catalog, error, loading, reload };
}

/** Grafana Explore link running a Tempo TraceQL query for the run's trace id (datasource uid "tempo"). */
export function traceExploreUrl(traceId: string): string | null {
  if (!GRAFANA_URL || !traceId) return null;
  const left = {
    datasource: "tempo",
    queries: [{ refId: "A", datasource: { type: "tempo", uid: "tempo" }, queryType: "traceql", query: traceId }],
    range: { from: "now-6h", to: "now" },
  };
  return `${GRAFANA_URL}/explore?left=${encodeURIComponent(JSON.stringify(left))}`;
}

export type ThreadPresence = "exists" | "missing" | "unknown";

/** Whether the Agent Server still has a thread (`langgraph dev` keeps threads in memory, so restarts drop them). */
export async function fetchThreadPresence(threadId: string, signal?: AbortSignal): Promise<ThreadPresence> {
  try {
    const response = await fetch(`${API_URL}/threads/${encodeURIComponent(threadId)}`, { signal, headers: { accept: "application/json" } });
    if (response.status === 404) return "missing";
    return response.ok ? "exists" : "unknown";
  } catch {
    return "unknown";
  }
}
