import { GoogleGenAI, type GenerateContentConfig, type ThinkingLevel } from "@google/genai";
import { emptyUsage, type Usage } from "@analytax/contracts";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { ResolvedModel } from "../models/factory.js";

export type WebSearchSource = { title: string; url: string };

export type WebSearchResult = {
  answer: string;
  sources: WebSearchSource[];
  queries: string[];
  model: string;
  usage: Usage;
};

export interface WebSearchClient {
  search(query: string, signal?: AbortSignal): Promise<WebSearchResult>;
}

/**
 * Google Search grounding via a dedicated Gemini call. LangChain can't mix Search grounding with custom function
 * tools in one request, so agents see search as an ordinary tool that performs its own grounded request.
 */
export class GeminiGroundedSearch implements WebSearchClient {
  private client: GoogleGenAI | null = null;

  constructor(
    private readonly resolveModel: () => ResolvedModel,
    private readonly onUsage?: (result: WebSearchResult, durationMs: number) => void,
  ) {}

  async search(query: string, signal?: AbortSignal): Promise<WebSearchResult> {
    this.client ??= new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
    const resolved = this.resolveModel();
    const config: GenerateContentConfig = { tools: [{ googleSearch: {} }] };
    if ("level" in resolved.thinking) {
      config.thinkingConfig = { thinkingLevel: resolved.thinking.level.toUpperCase() as ThinkingLevel };
    } else if ("budget" in resolved.thinking) {
      config.thinkingConfig = { thinkingBudget: resolved.thinking.budget };
    }
    if (signal) config.abortSignal = signal;

    const started = Date.now();
    const response = await this.client.models.generateContent({
      model: resolved.model,
      contents:
        "Use Google Search to answer the query below with specific, current facts (names, numbers, dates, versions). " +
        "Be concise and neutral; say so explicitly when information is unavailable or sources disagree.\n\n" +
        `Query: ${query}`,
      config,
    });

    const candidate = response.candidates?.[0];
    const seen = new Set<string>();
    const sources: WebSearchSource[] = [];
    for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
      const web = chunk.web;
      if (!web?.uri || seen.has(web.uri)) continue;
      seen.add(web.uri);
      sources.push({ title: web.title ?? web.domain ?? web.uri, url: web.uri });
    }
    const metadata = response.usageMetadata;
    const result: WebSearchResult = {
      answer: response.text ?? "",
      sources,
      queries: candidate?.groundingMetadata?.webSearchQueries ?? [],
      model: resolved.model,
      usage: {
        ...emptyUsage(),
        inputTokens: metadata?.promptTokenCount ?? 0,
        outputTokens: (metadata?.candidatesTokenCount ?? 0) + (metadata?.thoughtsTokenCount ?? 0),
        reasoningTokens: metadata?.thoughtsTokenCount ?? 0,
        cachedTokens: metadata?.cachedContentTokenCount ?? 0,
        modelCalls: 1,
      },
    };
    this.onUsage?.(result, Date.now() - started);
    return result;
  }
}

export function formatSearchResult(result: WebSearchResult): string {
  const sources = result.sources.length
    ? result.sources.map((source, index) => `[${index + 1}] ${source.title} — ${source.url}`).join("\n")
    : "(no grounded sources returned)";
  return `${result.answer.trim() || "(no answer)"}\n\nSources:\n${sources}`;
}

export function createWebSearchTool(client: WebSearchClient) {
  return tool(
    async ({ query }, config) => formatSearchResult(await client.search(query, config?.signal)),
    {
      name: "web_search",
      description:
        "Search the web with Google Search grounding for current, factual information. Returns a grounded summary " +
        "plus numbered source URLs. Use specific queries; never repeat an identical query.",
      schema: z.object({ query: z.string().describe("A specific search query") }),
    },
  );
}
