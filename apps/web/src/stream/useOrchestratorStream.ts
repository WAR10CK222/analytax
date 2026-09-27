import { useLangchainReactStream } from "./adapters/langchain-react";
import { useLegacySdkStream } from "./adapters/legacy-sdk";
import type { OrchestratorStream, OrchestratorStreamOptions } from "./types";

export type {
  OrchestratorStream,
  OrchestratorStreamOptions,
  OrchestratorValues,
  PendingInterrupt,
  RunOptionsInput,
} from "./types";

/** Chosen once at module load (`VITE_STREAM_SDK`), so the hook identity never changes between renders. */
export const STREAM_SDK: "react" | "legacy" =
  import.meta.env.VITE_STREAM_SDK?.trim().toLowerCase() === "legacy" ? "legacy" : "react";

/** The only entry point components use; it hides which LangGraph SDK drives the stream. */
export const useOrchestratorStream: (options: OrchestratorStreamOptions) => OrchestratorStream =
  STREAM_SDK === "legacy" ? useLegacySdkStream : useLangchainReactStream;
