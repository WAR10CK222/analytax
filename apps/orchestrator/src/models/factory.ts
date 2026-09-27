import type { Tier } from "@analytax/contracts";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogle } from "@langchain/google";
import type { ModelSpec, ModelsConfig, ThinkingSpec } from "../config/schema.js";
import { describeThinking } from "./capabilities.js";

export interface ResolvedModel {
  tier: Tier;
  model: string;
  thinking: ThinkingSpec;
  label: string;
  contextTokens: number;
  maxConcurrency: number;
}

/** Source of chat models per tier. Tests inject scripted models; production uses Gemini. */
export interface ModelFactory {
  resolve(tier: Tier): ResolvedModel;
  chatModel(tier: Tier): BaseChatModel;
}

export function resolveTier(config: ModelsConfig, tier: Tier): ResolvedModel {
  const spec = config.tiers[tier];
  const active: ModelSpec = config.useAlternates && spec.alternate ? spec.alternate : spec;
  return {
    tier,
    model: active.model,
    thinking: active.thinking,
    label: `${active.model} · ${describeThinking(active.thinking, active.model)}`,
    contextTokens: spec.contextTokens,
    maxConcurrency: spec.maxConcurrency,
  };
}

export function thinkingParams(thinking: ThinkingSpec): { thinkingLevel?: string; thinkingBudget?: number } {
  if ("level" in thinking) return { thinkingLevel: thinking.level };
  if ("budget" in thinking) return { thinkingBudget: thinking.budget };
  return {};
}

export class GeminiModelFactory implements ModelFactory {
  private readonly cache = new Map<Tier, BaseChatModel>();

  constructor(private readonly config: ModelsConfig) {}

  resolve(tier: Tier): ResolvedModel {
    return resolveTier(this.config, tier);
  }

  chatModel(tier: Tier): BaseChatModel {
    const cached = this.cache.get(tier);
    if (cached) return cached;
    const resolved = this.resolve(tier);
    // Temperature is intentionally not set (deprecated for Gemini 3.x). Retries: LangChain's AsyncCaller
    // retries 408/429/5xx with backoff and never retries 4xx validation errors.
    const model = new ChatGoogle({
      model: resolved.model,
      maxOutputTokens: this.config.defaults.maxOutputTokens,
      maxRetries: 3,
      maxConcurrency: resolved.maxConcurrency,
      // Runs streamed through the Agent Server protocol (the web UI) attach a stream-events handler, which makes
      // LangChain use ChatGoogle's stream-events converter. In @langchain/google 0.2.5 that converter drops
      // `thoughtSignature` / function-call ids (Gemini 3.x then rejects the next tool-loop turn with HTTP 400) and
      // `thoughtsTokenCount`. `generateContent` keeps both; live UI activity comes from our own custom events.
      disableStreaming: true,
      ...thinkingParams(resolved.thinking),
    });
    this.cache.set(tier, model);
    return model;
  }
}
