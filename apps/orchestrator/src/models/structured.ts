import { addUsage, emptyUsage, type Tier, type Usage } from "@analytax/contracts";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { z } from "zod";
import type { ModelsConfig, RoleName } from "../config/schema.js";
import type { ModelFactory } from "./factory.js";
import { usageFromMessage, withCost } from "./usage.js";

export interface StructuredCall<T> {
  role: RoleName;
  /** Overrides the role's configured tier (e.g. judge deep tasks one tier higher). */
  tier?: Tier;
  /** Function/schema name shown to the model. */
  name: string;
  schema: z.ZodType<T>;
  system: string;
  user: string;
  callbacks?: Callbacks;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface StructuredResult<T> {
  value: T;
  usage: Usage;
  model: string;
  tier: Tier;
}

/** Structured (schema-validated) LLM calls for the orchestrator's own roles: intake, planner, judge, synthesizer. */
export interface StructuredInvoker {
  invoke<T>(call: StructuredCall<T>): Promise<StructuredResult<T>>;
}

export class StructuredOutputError extends Error {
  override name = "StructuredOutputError";
}

type RawParsed = { raw?: BaseMessage; parsed?: unknown; parsing_error?: unknown };

export class ChatStructuredInvoker implements StructuredInvoker {
  constructor(
    private readonly models: ModelFactory,
    private readonly config: ModelsConfig,
  ) {}

  async invoke<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
    const tier = call.tier ?? this.config.roles[call.role];
    const resolved = this.models.resolve(tier);
    const model = this.models.chatModel(tier);
    const messages = [new SystemMessage(call.system), new HumanMessage(call.user)];
    let usage = emptyUsage();
    let lastError: unknown = null;

    // jsonSchema (native responseSchema) first; fall back to forced function calling if the model's JSON won't parse.
    for (const method of ["jsonSchema", "functionCalling"] as const) {
      const runnable = model.withStructuredOutput(call.schema as z.ZodType<Record<string, unknown>>, {
        name: call.name,
        method,
        includeRaw: true,
      });
      try {
        const result = (await runnable.invoke(messages, {
          callbacks: call.callbacks,
          signal: call.signal,
          runName: `${call.role}:${call.name}`,
          metadata: { ...call.metadata, analytax_role: call.role },
        })) as RawParsed;
        usage = addUsage(usage, usageFromMessage(result.raw));
        const parsed = call.schema.safeParse(result.parsed);
        if (parsed.success) {
          return { value: parsed.data, usage: withCost(usage, resolved.model, this.config.pricing), model: resolved.model, tier };
        }
        lastError = result.parsing_error ?? parsed.error;
      } catch (error) {
        if (!isOutputParsingError(error)) throw error;
        lastError = error;
      }
    }
    throw new StructuredOutputError(
      `${call.role} returned output that does not match ${call.name}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}

function isOutputParsingError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? "";
  return /MalformedOutput|OutputParser|SyntaxError|ZodError/i.test(name);
}
