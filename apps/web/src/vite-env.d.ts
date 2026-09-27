/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** LangGraph Agent Server base URL. Defaults to http://localhost:2024. */
  readonly VITE_LANGGRAPH_API_URL?: string;
  /** Grafana base URL used to build Tempo trace links. Empty hides the link. */
  readonly VITE_GRAFANA_URL?: string;
  /** Streaming adapter: "react" (default) or "legacy". */
  readonly VITE_STREAM_SDK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
