import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { SpanKind, SpanStatusCode, type Attributes, type HrTime } from "@opentelemetry/api";
import { ExportResultCode, hrTimeToMilliseconds, type ExportResult } from "@opentelemetry/core";
import {
  AggregationTemporality,
  DataPointType,
  type MetricData,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

const isoFromHr = (time: HrTime): string => new Date(hrTimeToMilliseconds(time)).toISOString();
const round = (value: number): number => Math.round(value * 1000) / 1000;

type ExportCallback = (result: ExportResult) => void;

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/** Appends JSON lines to `<dir>/<prefix>-YYYY-MM-DD.jsonl`; writes are serialized so lines never interleave. */
export class JsonlFileWriter {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly prefix: string,
  ) {}

  fileFor(date = new Date()): string {
    return path.join(this.dir, `${this.prefix}-${date.toISOString().slice(0, 10)}.jsonl`);
  }

  write(records: readonly unknown[]): Promise<void> {
    if (records.length === 0) return this.queue;
    const payload = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const task = this.queue.then(async () => {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.fileFor(), payload, "utf8");
    });
    // Keep the chain usable after a failed write; the caller still sees the failure via `task`.
    this.queue = task.catch(() => undefined);
    return task;
  }

  flush(): Promise<void> {
    return this.queue;
  }
}

export function spanToRecord(span: ReadableSpan): Record<string, unknown> {
  const context = span.spanContext();
  const record: Record<string, unknown> = {
    time: isoFromHr(span.startTime),
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    kind: SpanKind[span.kind],
    durationMs: round(hrTimeToMilliseconds(span.duration)),
    status: SpanStatusCode[span.status.code],
  };
  if (span.status.message) record.statusMessage = span.status.message;
  record.attributes = span.attributes;
  if (span.events.length > 0) {
    record.events = span.events.map((event) => ({
      name: event.name,
      time: isoFromHr(event.time),
      ...(event.attributes && Object.keys(event.attributes).length > 0 ? { attributes: event.attributes } : {}),
    }));
  }
  record.service = span.resource.attributes["service.name"] ?? null;
  record.scope = span.instrumentationScope.name;
  return record;
}

/** Local-development span exporter: one JSON object per span in `traces-YYYY-MM-DD.jsonl`. */
export class JsonlSpanExporter implements SpanExporter {
  private readonly writer: JsonlFileWriter;
  private stopped = false;

  constructor(dir: string) {
    this.writer = new JsonlFileWriter(dir, "traces");
  }

  export(spans: ReadableSpan[], resultCallback: ExportCallback): void {
    if (this.stopped) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error("JsonlSpanExporter is shut down") });
      return;
    }
    this.writer.write(spans.map(spanToRecord)).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      (error: unknown) => resultCallback({ code: ExportResultCode.FAILED, error: toError(error) }),
    );
  }

  forceFlush(): Promise<void> {
    return this.writer.flush();
  }

  async shutdown(): Promise<void> {
    await this.writer.flush();
    this.stopped = true;
  }
}

type HistogramValue = { count: number; sum?: number; min?: number; max?: number };
type PointValue = number | HistogramValue;

function pointValue(metric: MetricData, value: unknown): PointValue | null {
  if (metric.dataPointType === DataPointType.HISTOGRAM || metric.dataPointType === DataPointType.EXPONENTIAL_HISTOGRAM) {
    const histogram = value as HistogramValue;
    if (histogram.count === 0) return null;
    return { count: histogram.count, sum: histogram.sum, min: histogram.min, max: histogram.max };
  }
  if (typeof value !== "number") return null;
  // A delta sum of 0 only says "nothing happened this interval".
  if (metric.dataPointType === DataPointType.SUM && metric.aggregationTemporality === AggregationTemporality.DELTA && value === 0) {
    return null;
  }
  return value;
}

export function metricsToRecords(metrics: ResourceMetrics, now = new Date()): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const scope of metrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      const points: { attributes: Attributes; value: PointValue }[] = [];
      for (const point of metric.dataPoints as readonly { attributes: Attributes; value: unknown }[]) {
        const value = pointValue(metric, point.value);
        if (value !== null) points.push({ attributes: point.attributes, value });
      }
      if (points.length === 0) continue;
      records.push({
        time: now.toISOString(),
        name: metric.descriptor.name,
        unit: metric.descriptor.unit || undefined,
        type: DataPointType[metric.dataPointType],
        temporality: AggregationTemporality[metric.aggregationTemporality],
        scope: scope.scope.name,
        points,
      });
    }
  }
  return records;
}

/**
 * Local-development metric exporter: delta temporality, so each line holds only what changed since the previous
 * export and idle intervals write nothing. Output: `metrics-YYYY-MM-DD.jsonl`.
 */
export class JsonlMetricExporter implements PushMetricExporter {
  private readonly writer: JsonlFileWriter;

  constructor(dir: string) {
    this.writer = new JsonlFileWriter(dir, "metrics");
  }

  export(metrics: ResourceMetrics, resultCallback: ExportCallback): void {
    this.writer.write(metricsToRecords(metrics)).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      (error: unknown) => resultCallback({ code: ExportResultCode.FAILED, error: toError(error) }),
    );
  }

  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.DELTA;
  }

  forceFlush(): Promise<void> {
    return this.writer.flush();
  }

  shutdown(): Promise<void> {
    return this.writer.flush();
  }
}
