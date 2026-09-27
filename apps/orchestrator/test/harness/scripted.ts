import {
  emptyUsage,
  type IntentAnalysis,
  type PlanDraftWire,
  type PlanPatchWire,
  type SynthesisWire,
  type TaskOutcomeWire,
  type Tier,
  type VerdictWire,
} from "@analytax/contracts";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { AgentRunArgs, AgentRunResult, AgentRunner } from "../../src/agents/runtime.js";
import type { StructuredCall, StructuredInvoker, StructuredResult } from "../../src/models/structured.js";

// ----------------------------------------------------------------------------------------------------------------
// Role calls (intake / planner / replanner / judge / synthesizer)
// ----------------------------------------------------------------------------------------------------------------

type Handler<T> = (call: StructuredCall<unknown>, index: number) => T | Promise<T>;

export type RoleScripts = {
  intake?: Handler<IntentAnalysis>;
  planner?: Handler<PlanDraftWire>;
  replanner?: Handler<PlanPatchWire>;
  judge?: Handler<VerdictWire>;
  synthesizer?: Handler<SynthesisWire>;
};

export const planIntent = (overrides: Partial<IntentAnalysis> = {}): IntentAnalysis => ({
  goal: "Answer the client's question",
  intentType: "analysis",
  deliverable: { format: "recommendation", audience: "general", length: "medium" },
  constraints: [],
  complexity: "medium",
  path: "plan",
  suggestedCapability: "analysis",
  ambiguity: { isAmbiguous: false, questions: [] },
  ...overrides,
});

/** Accepts when every acceptance criterion is present; parse criteria from the judge prompt. */
export const acceptAll: Handler<VerdictWire> = (call) => ({
  criteria: criteriaFrom(call.user).map((criterion) => ({ criterion, met: true, note: "ok" })),
  issues: [],
  decision: "accept",
  score: 0.9,
  feedback: "",
  missingPrerequisite: "",
});

export const rejectWith = (feedback: string): VerdictWire => ({
  criteria: [{ criterion: "quality", met: false, note: feedback }],
  issues: [{ severity: "major", text: feedback }],
  decision: "revise",
  score: 0.3,
  feedback,
  missingPrerequisite: "",
});

export function criteriaFrom(prompt: string): string[] {
  const block = /<acceptance_criteria>\n([\s\S]*?)\n<\/acceptance_criteria>/.exec(prompt)?.[1] ?? "";
  return block
    .split("\n")
    .map((line) => line.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean);
}

export const titleFrom = (prompt: string): string => /<title>([\s\S]*?)<\/title>/.exec(prompt)?.[1]?.trim() ?? "";

export class ScriptedStructuredInvoker implements StructuredInvoker {
  readonly calls: StructuredCall<unknown>[] = [];

  constructor(private readonly scripts: RoleScripts) {}

  count(role: StructuredCall<unknown>["role"]): number {
    return this.calls.filter((call) => call.role === role).length;
  }

  async invoke<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
    const index = this.count(call.role);
    this.calls.push(call as StructuredCall<unknown>);
    const handler = this.scripts[call.role as keyof RoleScripts] as Handler<unknown> | undefined;
    let value: unknown;
    if (handler) value = await handler(call as StructuredCall<unknown>, index);
    else if (call.role === "intake") value = planIntent();
    else if (call.role === "judge") value = await acceptAll(call as StructuredCall<unknown>, index);
    else if (call.role === "synthesizer") value = { answer: "Final answer.", limitations: [] } satisfies SynthesisWire;
    else throw new Error(`No script for role '${call.role}'`);
    return {
      value: call.schema.parse(value),
      usage: { ...emptyUsage(), inputTokens: 100, outputTokens: 50, modelCalls: 1 },
      model: `scripted-${call.role}`,
      tier: (call.tier ?? "fast") as Tier,
    };
  }
}

// ----------------------------------------------------------------------------------------------------------------
// Agents
// ----------------------------------------------------------------------------------------------------------------

export type AgentCallContext = {
  agentId: string;
  tier: Tier;
  taskId: string;
  attempt: number;
  dispatchId: string;
  title: string;
  prompt: string;
  /** Names of the MCP tools the dispatch handed to the agent. */
  mcpTools: string[];
};

export type AgentScript = (context: AgentCallContext) => TaskOutcomeWire | Error | Promise<TaskOutcomeWire | Error>;

export const wireOutcome = (overrides: Partial<TaskOutcomeWire> = {}): TaskOutcomeWire => ({
  status: "completed",
  summary: "Completed the task.",
  output: "A complete and sufficiently detailed result for the task at hand.",
  keyFindings: ["key finding"],
  sources: [{ title: "Example source", url: "https://example.com/source" }],
  confidence: 0.9,
  assumptions: [],
  openQuestions: [],
  proposals: [],
  ...overrides,
});

const TASK_HEADER = /<task id="([^"]+)" attempt="(\d+)" dispatch="([^"]+)" agent="([^"]+)">/;

/** Deterministic agent stand-in keyed by the `<task …>` header, so parallel dispatch order doesn't matter. */
export class ScriptedAgentRunner implements AgentRunner {
  readonly calls: AgentCallContext[] = [];

  constructor(
    private readonly script: AgentScript,
    private readonly latencyMs: () => number = () => 0,
  ) {}

  async run(args: AgentRunArgs): Promise<AgentRunResult> {
    const header = TASK_HEADER.exec(args.prompt);
    if (!header) throw new Error("Prompt is missing the <task> header");
    const context: AgentCallContext = {
      taskId: header[1]!,
      attempt: Number(header[2]),
      dispatchId: header[3]!,
      agentId: args.agentId,
      tier: args.tier,
      title: titleFrom(args.prompt),
      prompt: args.prompt,
      mcpTools: (args.mcp?.tools ?? []).map((entry) => entry.name),
    };
    this.calls.push(context);
    const delay = this.latencyMs();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const result = await this.script(context);
    if (result instanceof Error) throw result;
    const message = new AIMessage({
      content: "",
      usage_metadata: { input_tokens: 200, output_tokens: 80, total_tokens: 280 },
    });
    return { structured: result, messages: [message] as BaseMessage[] };
  }
}
