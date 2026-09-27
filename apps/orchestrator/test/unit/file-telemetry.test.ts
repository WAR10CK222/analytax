import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlMetricExporter, JsonlSpanExporter } from "../../src/telemetry/file-exporters.js";

type JsonRecord = Record<string, unknown> & { name: string };

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "analytax-telemetry-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function readJsonl(dir: string, prefix: string): Promise<JsonRecord[]> {
  const files = (await readdir(dir)).filter((file) => file.startsWith(`${prefix}-`));
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.jsonl$`));
  const text = await readFile(path.join(dir, files[0]!), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as JsonRecord);
}

describe("file telemetry exporters", () => {
  it("writes spans as JSON lines with parent links, attributes and events", async () => {
    const dir = await tempDir();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new JsonlSpanExporter(dir))] });
    const tracer = provider.getTracer("analytax-test");
    const agent = tracer.startSpan("invoke_agent researcher", { attributes: { "gen_ai.agent.id": "researcher" } });
    const chat = tracer.startSpan("chat gemini-3.6-flash", { attributes: { "gen_ai.usage.input_tokens": 120 } }, trace.setSpan(ROOT_CONTEXT, agent));
    chat.addEvent("plan.patched", { version: 2 });
    chat.end();
    agent.end();
    await provider.forceFlush();

    const records = await readJsonl(dir, "traces");
    expect(records.map((record) => record.name)).toEqual(["chat gemini-3.6-flash", "invoke_agent researcher"]);
    const [chatRecord, agentRecord] = records;
    expect(chatRecord).toMatchObject({
      traceId: agent.spanContext().traceId,
      parentSpanId: agent.spanContext().spanId,
      kind: "INTERNAL",
      status: "UNSET",
      attributes: { "gen_ai.usage.input_tokens": 120 },
      events: [{ name: "plan.patched", attributes: { version: 2 } }],
    });
    expect(agentRecord).toMatchObject({ parentSpanId: null, attributes: { "gen_ai.agent.id": "researcher" } });
    await provider.shutdown();
  });

  it("writes delta metrics and skips intervals without new measurements", async () => {
    const dir = await tempDir();
    const reader = new PeriodicExportingMetricReader({ exporter: new JsonlMetricExporter(dir), exportIntervalMillis: 60_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const meter = provider.getMeter("analytax-test");
    meter.createHistogram("gen_ai.client.token.usage", { unit: "{token}" }).record(42, { "gen_ai.token.type": "input" });
    meter.createCounter("analytax.task.outcomes").add(2, { status: "completed" });

    await reader.forceFlush();
    await reader.forceFlush(); // nothing new → nothing written

    const records = await readJsonl(dir, "metrics");
    expect(records.map((record) => record.name).sort()).toEqual(["analytax.task.outcomes", "gen_ai.client.token.usage"]);
    expect(records.find((record) => record.name === "gen_ai.client.token.usage")).toMatchObject({
      type: "HISTOGRAM",
      temporality: "DELTA",
      unit: "{token}",
      points: [{ attributes: { "gen_ai.token.type": "input" }, value: { count: 1, sum: 42 } }],
    });
    expect(records.find((record) => record.name === "analytax.task.outcomes")).toMatchObject({ type: "SUM", points: [{ value: 2 }] });
    await provider.shutdown();
  });
});
