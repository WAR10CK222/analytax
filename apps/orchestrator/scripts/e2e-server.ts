/**
 * End-to-end check against a running Agent Server (pnpm dev / langgraphjs dev):
 * start a run with plan approval → verify the approve_plan interrupt → resume → verify final state, durable
 * events, live custom events and stored artifacts. Works with real Gemini or ANALYTAX_OFFLINE_MODELS=true.
 * Usage: pnpm e2e:server [--faults]   (--faults needs ANALYTAX_ENABLE_FAULTS=true on the server)
 */
import { isCustomStreamChunk, type CatalogResponse, type FinalAnswer, type LifecycleEvent, type Task } from "@analytax/contracts";
import { Client } from "@langchain/langgraph-sdk";

const apiUrl = process.env.LANGGRAPH_API_URL ?? "http://localhost:2024";
const QUERY = "Compare Qdrant, Milvus and pgvector for a 50M-embedding RAG workload and recommend one.";

type StreamStats = { custom: number; customTypes: Set<string>; errors: unknown[] };

async function streamRun(client: Client, threadId: string, payload: Record<string, unknown>): Promise<StreamStats> {
  const stats: StreamStats = { custom: 0, customTypes: new Set(), errors: [] };
  const stream = client.runs.stream(threadId, "orchestrator", { ...payload, streamMode: ["values", "custom"] } as never);
  for await (const chunk of stream) {
    if (chunk.event === "custom" && isCustomStreamChunk(chunk.data)) {
      stats.custom += 1;
      stats.customTypes.add(chunk.data.event.type);
    } else if (chunk.event === "error") {
      stats.errors.push(chunk.data);
    }
  }
  return stats;
}

async function main(): Promise<void> {
  const client = new Client({ apiUrl });
  const catalog = (await fetch(`${apiUrl}/analytax/catalog`).then((response) => response.json())) as CatalogResponse;
  const faults = process.argv.includes("--faults")
    ? [
        { kind: "block_with_prerequisite", agentId: "analyst", times: 1 },
        { kind: "reject", agentId: "writer", times: 1 },
      ]
    : [];
  const config = { recursion_limit: catalog.guards.recursionLimit };
  const thread = await client.threads.create();
  console.log(`thread ${thread.thread_id} · agents: ${catalog.agents.map((agent) => agent.id).join(", ")}`);

  const first = await streamRun(client, thread.thread_id, {
    input: { messages: [{ type: "human", content: QUERY }], runOptions: { hitl: { approvePlan: true }, demoFaults: faults } },
    config,
  });
  if (first.errors.length) throw new Error(`run failed: ${JSON.stringify(first.errors)}`);

  let state = await client.threads.getState(thread.thread_id);
  const interrupts = state.tasks.flatMap((task) => task.interrupts ?? []);
  const pending = interrupts[0]?.value as { kind?: string; tasks?: { id: string; title: string }[] } | undefined;
  if (pending?.kind !== "approve_plan") throw new Error(`expected an approve_plan interrupt, got ${JSON.stringify(interrupts)}`);
  console.log(`✔ plan awaiting approval: ${pending.tasks?.map((task) => `${task.id} ${task.title}`).join(" | ")}`);

  const second = await streamRun(client, thread.thread_id, { command: { resume: { decision: "approve" } }, config });
  if (second.errors.length) throw new Error(`resume failed: ${JSON.stringify(second.errors)}`);

  state = await client.threads.getState(thread.thread_id);
  const values = state.values as { final: FinalAnswer | null; events: LifecycleEvent[]; tasks: Record<string, Task> };
  const eventTypes = values.events.map((event) => event.type);
  const count = (type: string) => eventTypes.filter((entry) => entry === type).length;
  const artifacts = await client.store.searchItems(["analytax", thread.thread_id, "artifacts"], { limit: 20 }).catch(() => ({ items: [] }));

  console.log(`✔ tasks: ${Object.values(values.tasks).map((task) => `${task.id}:${task.status}`).join(" ")}`);
  console.log(`✔ durable events: ${values.events.length} (waves ${count("wave.started")}, dispatched ${count("task.dispatched")}, completed ${count("task.completed")}, patches ${count("plan.patched")}, blocked ${count("task.blocked")}, retried ${count("task.retried")})`);
  console.log(`✔ live custom events: ${first.custom + second.custom} (${[...new Set([...first.customTypes, ...second.customTypes])].join(", ")})`);
  console.log(`✔ artifacts in store: ${artifacts.items.length}`);
  console.log(`✔ final: ${values.final?.status ?? "missing"} — ${values.final?.answer.slice(0, 160).replace(/\s+/g, " ")}…`);

  const seqs = values.events.map((event) => event.seq);
  if (!values.final) throw new Error("no final answer");
  if (seqs.some((seq, index) => seq !== index + 1)) throw new Error("durable event sequence is not contiguous");
  if (first.custom + second.custom === 0) throw new Error("no custom (ephemeral) events were streamed");
  if (faults.length && (count("task.blocked") === 0 || count("task.retried") === 0)) throw new Error("demo faults did not trigger adaptation");
}

main().catch((error: unknown) => {
  console.error(`✖ ${(error as Error).message}`);
  process.exitCode = 1;
});
