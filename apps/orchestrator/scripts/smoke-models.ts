/**
 * Live smoke test of every configured Gemini tier (needs GOOGLE_API_KEY):
 *   1. structured output (jsonSchema)            — role calls: intake, planner, judge, synthesizer
 *   2. agent tool round-trip + toolStrategy      — thought signatures survive the tool loop, outcome parses
 * Usage: pnpm smoke:models [--tier fast] [--search] [--stream-v3]
 *   --stream-v3  runs the tool loop under a callback handler that prefers chat-model stream events, like the Agent
 *                Server does for runs started from the web UI (the path that used to drop thought signatures).
 */
import path from "node:path";
import { TIERS, TaskOutcomeWire, type Tier } from "@analytax/contracts";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { z } from "zod";

type Row = { tier: Tier; model: string; check: string; ok: boolean; ms: number; detail: string };

/** Mimics LangGraph's v3 stream handler: it asks chat models for stream events instead of a plain generate call. */
class StreamEventsHandler extends BaseCallbackHandler {
  name = "smoke-stream-v3";
  lc_prefer_chat_model_stream_events = true;
}

function loadEnv(): void {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
  } catch {
    // rely on the ambient environment
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T | null; ms: number; error: string | null }> {
  const started = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - started, error: null };
  } catch (error) {
    return { value: null, ms: Date.now() - started, error: (error as Error).message };
  }
}

async function main(): Promise<void> {
  loadEnv();
  process.env.ANALYTAX_TELEMETRY_ENABLED = "false";
  process.env.LOG_LEVEL ??= "warn";
  if (!process.env.GOOGLE_API_KEY) {
    console.error("✖ GOOGLE_API_KEY is not set (add it to the repo-root .env)");
    process.exitCode = 1;
    return;
  }
  const args = process.argv.slice(2);
  const tierArg = args.includes("--tier") ? args[args.indexOf("--tier") + 1] : undefined;
  const tiers = TIERS.filter((tier) => !tierArg || tier === tierArg);
  const streamV3 = args.includes("--stream-v3");

  const { createDefaultDeps } = await import("../src/graph/deps.js");
  const deps = createDefaultDeps();
  const rows: Row[] = [];

  for (const tier of tiers) {
    const { model } = deps.models.resolve(tier);

    const structured = await timed(() =>
      deps.structured.invoke({
        role: "intake",
        tier,
        name: "smoke_answer",
        schema: z.object({ answer: z.string(), confidence: z.number() }),
        system: "Answer the question concisely.",
        user: "What is the capital city of Australia?",
      }),
    );
    rows.push({
      tier,
      model,
      check: "structured output",
      ok: Boolean(structured.value?.value.answer.toLowerCase().includes("canberra")),
      ms: structured.ms,
      detail: structured.error ?? `answer="${structured.value?.value.answer}" out_tokens=${structured.value?.usage.outputTokens}`,
    });

    const agent = await timed(() =>
      deps.agentRunner.run({
        agentId: "generalist",
        tier,
        dispatchId: `smoke-${tier}`,
        signal: AbortSignal.timeout(180_000),
        ...(streamV3 ? { callbacks: [new StreamEventsHandler()] } : {}),
        prompt: [
          `<task id="smoke" attempt="1" dispatch="smoke-${tier}" agent="generalist">`,
          "<title>Smoke test</title>",
          "<instructions>Use the calculator tool to compute 1234 * 5678, then submit your outcome with the exact result in the output.</instructions>",
          "<acceptance_criteria>\n1. The calculator tool was used\n2. The output contains 7006652\n</acceptance_criteria>",
          "</task>",
        ].join("\n"),
      }),
    );
    const usedTool = agent.value?.messages.some((message) => message.type === "tool" && message.name === "calculator") ?? false;
    const outcome = agent.value?.structured ? TaskOutcomeWire.safeParse(agent.value.structured) : null;
    const correct = Boolean(outcome?.success && outcome.data.output.replace(/[,\s]/g, "").includes("7006652"));
    const reasoning = agent.value?.messages.reduce((sum, message) => {
      const details = (message as { usage_metadata?: { output_token_details?: { reasoning?: number } } }).usage_metadata?.output_token_details;
      return sum + (details?.reasoning ?? 0);
    }, 0);
    rows.push({
      tier,
      model,
      check: streamV3 ? "tool loop (stream-v3)" : "tool loop + outcome",
      ok: usedTool && correct,
      ms: agent.ms,
      detail:
        agent.error ??
        `tool=${usedTool} outcome=${outcome?.success ?? false} correct=${correct} messages=${agent.value?.messages.length} reasoning_tokens=${reasoning ?? 0}`,
    });
  }

  if (args.includes("--search")) {
    const search = await timed(async () => String(await deps.tools.get("web_search").invoke({ query: "current Node.js LTS release line" })));
    rows.push({
      tier: deps.config.models.roles.search,
      model: deps.models.resolve(deps.config.models.roles.search).model,
      check: "google search grounding",
      ok: Boolean(search.value?.includes("http")),
      ms: search.ms,
      detail: search.error ?? `${search.value?.slice(0, 120).replace(/\s+/g, " ")}…`,
    });
  }

  console.log("");
  for (const row of rows) {
    console.log(`${row.ok ? "✔" : "✖"} ${row.tier.padEnd(14)} ${row.model.padEnd(24)} ${row.check.padEnd(24)} ${String(row.ms).padStart(6)} ms  ${row.detail}`);
  }
  if (rows.some((row) => !row.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
