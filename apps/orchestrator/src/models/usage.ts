import { addUsage, emptyUsage, type Usage } from "@analytax/contracts";
import type { BaseMessage } from "@langchain/core/messages";
import type { ModelsConfig } from "../config/schema.js";

type UsageMetadataLike = {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { cache_read?: number };
  output_token_details?: { reasoning?: number };
};

const isAi = (message: BaseMessage): boolean => message.type === "ai";
const isTool = (message: BaseMessage): boolean => message.type === "tool";

export function usageFromMessage(message: BaseMessage | null | undefined): Usage {
  if (!message || !isAi(message)) return emptyUsage();
  const metadata = (message as BaseMessage & { usage_metadata?: UsageMetadataLike }).usage_metadata;
  return {
    inputTokens: metadata?.input_tokens ?? 0,
    // From generateContent, output_tokens = candidates + thoughts, and output_token_details.reasoning = thoughts.
    // (The stream-events path reported candidates only, which is why the factory disables streaming.)
    outputTokens: metadata?.output_tokens ?? 0,
    reasoningTokens: metadata?.output_token_details?.reasoning ?? 0,
    cachedTokens: metadata?.input_token_details?.cache_read ?? 0,
    modelCalls: 1,
    toolCalls: 0,
    costUsd: 0,
  };
}

export function usageFromMessages(messages: readonly BaseMessage[]): Usage {
  let usage = emptyUsage();
  for (const message of messages) {
    if (isAi(message)) usage = addUsage(usage, usageFromMessage(message));
    else if (isTool(message)) usage = { ...usage, toolCalls: usage.toolCalls + 1 };
  }
  return usage;
}

export function withCost(usage: Usage, model: string, pricing: ModelsConfig["pricing"]): Usage {
  const price = pricing[model];
  if (!price) return usage;
  const costUsd = (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
  return { ...usage, costUsd: usage.costUsd + costUsd };
}
