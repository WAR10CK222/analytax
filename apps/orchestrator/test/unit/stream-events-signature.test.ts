import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatGoogle } from "@langchain/google";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiModelFactory } from "../../src/models/factory.js";
import { usageFromMessage } from "../../src/models/usage.js";
import { testConfig } from "../helpers.js";

/**
 * Regression for the Gemini 3.x "missing thought_signature" 400s. Runs streamed through the Agent Server protocol
 * (the web UI) attach a callback handler that prefers chat-model stream events. With @langchain/google 0.2.5 that
 * path dropped `thoughtSignature`, function-call ids and `thoughtsTokenCount`. The factory must keep all three.
 */
class StreamEventsHandler extends BaseCallbackHandler {
  name = "langgraph-v3-stream-events";
  lc_prefer_chat_model_stream_events = true;
}

const SIGNATURE = "SIG_ABC123";

const toolCallResponse = {
  candidates: [
    {
      content: {
        role: "model",
        parts: [{ functionCall: { id: "call_1", name: "web_search", args: { query: "vector databases" } }, thoughtSignature: SIGNATURE }],
      },
      finishReason: "STOP",
    },
  ],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 20, thoughtsTokenCount: 300, totalTokenCount: 440 },
  modelVersion: "gemini-3.1-pro-preview",
};

const finalResponse = {
  candidates: [{ content: { role: "model", parts: [{ text: "Qdrant fits best." }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 8, thoughtsTokenCount: 40, totalTokenCount: 248 },
  modelVersion: "gemini-3.1-pro-preview",
};

type Captured = { url: string; body: string };

function sse(payload: unknown): Response {
  return new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

describe("Gemini tool loop under a stream-events handler", () => {
  let requests: Captured[];

  beforeEach(() => {
    requests = [];
    vi.stubEnv("GOOGLE_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request | string, init?: RequestInit) => {
        const request = typeof input === "string" ? new Request(input, init) : input;
        requests.push({ url: request.url, body: await request.clone().text() });
        const payload = requests.length === 1 ? toolCallResponse : finalResponse;
        return request.url.includes("streamGenerateContent") ? sse(payload) : Response.json(payload);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function runToolLoop(model: ChatGoogle | ReturnType<GeminiModelFactory["chatModel"]>): Promise<{ first: AIMessage; second: AIMessage }> {
    const callbacks = [new StreamEventsHandler()];
    const human = new HumanMessage("Which vector database fits a 50M-embedding RAG workload?");
    const first = (await model.invoke([human], { callbacks })) as AIMessage;
    const toolCall = first.tool_calls?.[0];
    const history: BaseMessage[] = [
      human,
      first,
      new ToolMessage({ content: "Qdrant: filtered HNSW, single binary.", tool_call_id: toolCall?.id ?? "missing", name: "web_search" }),
    ];
    const second = (await model.invoke(history, { callbacks })) as AIMessage;
    return { first, second };
  }

  it("really takes the stream-events path when streaming is enabled (guards the test itself)", async () => {
    const plain = new ChatGoogle({ model: "gemini-3.1-pro-preview", apiKey: "test-key", thinkingLevel: "low" });
    await plain.invoke([new HumanMessage("hi")], { callbacks: [new StreamEventsHandler()] });
    expect(requests[0]?.url).toContain(":streamGenerateContent");
  });

  it("keeps the thought signature, the call id and reasoning usage with the factory's models", async () => {
    const factory = new GeminiModelFactory(testConfig().models);
    const { first } = await runToolLoop(factory.chatModel("standard"));

    expect(requests.every((request) => request.url.includes(":generateContent"))).toBe(true);
    expect(first.tool_calls?.[0]).toMatchObject({ name: "web_search", id: "call_1" });

    const usage = usageFromMessage(first);
    expect(usage.reasoningTokens).toBe(300);
    expect(usage.outputTokens).toBeGreaterThanOrEqual(300);

    const followUp = JSON.parse(requests[1]?.body ?? "{}") as {
      contents?: { role: string; parts: { functionCall?: unknown; thoughtSignature?: string }[] }[];
    };
    const modelTurn = followUp.contents?.find((content) => content.role === "model");
    const callPart = modelTurn?.parts.find((part) => part.functionCall);
    expect(callPart?.thoughtSignature).toBe(SIGNATURE);
  });
});
