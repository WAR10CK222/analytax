import path from "node:path";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { isMcpOrigin } from "../mcp/origins.js";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { resolveHome } from "../config/load.js";
import { logger } from "../util/logger.js";
import { JsonlMetricExporter, JsonlSpanExporter } from "./file-exporters.js";

export type TelemetryExporter = "file" | "otlp" | "none";

let sdk: NodeSDK | null = null;

/**
 * ANALYTAX_TELEMETRY_EXPORTER:
 *   file (default) — JSON lines under logs/telemetry (no collector needed)
 *   otlp           — OTLP/proto to OTEL_EXPORTER_OTLP_ENDPOINT (e.g. Grafana LGTM)
 *   none           — disabled (ANALYTAX_TELEMETRY_ENABLED=false does the same)
 */
export function telemetryExporter(): TelemetryExporter {
  if (process.env.ANALYTAX_TELEMETRY_ENABLED === "false") return "none";
  const value = process.env.ANALYTAX_TELEMETRY_EXPORTER?.trim().toLowerCase();
  return value === "otlp" || value === "none" ? value : "file";
}

export const telemetryEnabled = (): boolean => telemetryExporter() !== "none";

/** Output folder for the file exporter; relative paths resolve from the repo root. */
export const telemetryDir = (): string => path.resolve(resolveHome(), process.env.ANALYTAX_TELEMETRY_DIR?.trim() || path.join("logs", "telemetry"));

/**
 * Starts the OpenTelemetry Node SDK once per process.
 * Undici (fetch) instrumentation uses diagnostics_channel, so it works without ESM loader hooks — important under
 * the LangGraph CLI, which installs its own preload. It only traces fetches made inside an Analytax span.
 */
export function startTelemetry(): boolean {
  const exporter = telemetryExporter();
  if (sdk || exporter === "none") return false;

  const toFile = exporter === "file";
  const dir = telemetryDir();
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "analytax-orchestrator",
      [ATTR_SERVICE_VERSION]: "0.1.0",
    }),
    traceExporter: toFile ? new JsonlSpanExporter(dir) : new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: toFile ? new JsonlMetricExporter(dir) : new OTLPMetricExporter(),
      exportIntervalMillis: toFile ? 15_000 : 10_000,
    }),
    instrumentations: [new UndiciInstrumentation({ requireParentforSpans: true, ignoreRequestHook: (request) => isMcpOrigin(request.origin) })],
  });
  sdk.start();
  logger.info(toFile ? { exporter, dir } : { exporter, endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318" }, "telemetry started");

  const shutdown = () => {
    void sdk?.shutdown().catch(() => undefined);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("beforeExit", shutdown);
  return true;
}
