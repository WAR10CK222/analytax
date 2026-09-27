import { TaskOutcomeWire, type Tier } from "@analytax/contracts";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createAgent, modelCallLimitMiddleware, toolCallLimitMiddleware, toolStrategy } from "langchain";
import { z } from "zod";
import { splitToolRefs } from "../mcp/refs.js";
import type { ModelFactory } from "../models/factory.js";
import type { SkillRegistry, SkillRecord } from "../skills/registry.js";
import { createSkillsMiddleware } from "../skills/middleware.js";
import type { ToolRegistry } from "../tools/registry.js";
import { createReadArtifactTool, createToolLoopGuardMiddleware, createUiEventsMiddleware } from "./middleware.js";
import { buildSystemPrompt, OUTCOME_TOOL_NAME } from "./prompt.js";
import type { AgentRegistry } from "./registry.js";

export type AgentRunArgs = {
  agentId: string;
  tier: Tier;
  prompt: string;
  dispatchId: string;
  signal: AbortSignal;
  callbacks?: Callbacks;
  /** MCP tools resolved for this dispatch; `fingerprint` changes whenever the tool set does. */
  mcp?: { tools: StructuredToolInterface[]; fingerprint: string };
};

export type AgentRunResult = {
  /** Raw structured response (validated against TaskOutcomeWire by the agent), or null if none was submitted. */
  structured: TaskOutcomeWire | null;
  messages: BaseMessage[];
};

/** Runs one agent turn for one dispatch. Tests substitute scripted runners. */
export interface AgentRunner {
  run(args: AgentRunArgs): Promise<AgentRunResult>;
}

type InvokableAgent = {
  invoke(input: { messages: BaseMessage[] }, config: Record<string, unknown>): Promise<{ structuredResponse?: unknown; messages?: BaseMessage[] }>;
};

export const AgentRunContext = z.object({ dispatchId: z.string() });

export const OutcomeResponseSchema = TaskOutcomeWire.meta({
  title: OUTCOME_TOOL_NAME,
  description: "Submit your final outcome for the task. Call exactly once, when you are finished.",
});

export type AgentRuntimeDeps = {
  agents: AgentRegistry;
  skills: SkillRegistry;
  tools: ToolRegistry;
  models: ModelFactory;
  home: string;
  configHash: string;
};

/** Built agents kept per agent × tier × config × MCP tool set; the oldest are dropped past this many. */
const MAX_CACHED_AGENTS = 64;

/** Builds (and memoizes per agent × tier × config × MCP tool set) a LangChain `createAgent` for each agent card. */
export class AgentRuntimes implements AgentRunner {
  private readonly cache = new Map<string, InvokableAgent>();
  private readonly readArtifact = createReadArtifactTool();
  private readonly loopGuard = createToolLoopGuardMiddleware();

  constructor(private readonly deps: AgentRuntimeDeps) {}

  private build(agentId: string, tier: Tier, mcpTools: readonly StructuredToolInterface[]): InvokableAgent {
    const card = this.deps.agents.require(agentId);
    const resolved = this.deps.models.resolve(tier);
    const skills = card.skills.map((name) => this.deps.skills.get(name)).filter((skill): skill is SkillRecord => skill !== undefined);
    const skillsMiddleware = createSkillsMiddleware(skills);
    const tools: StructuredToolInterface[] = [...this.deps.tools.resolve(splitToolRefs(card.tools).builtin), ...mcpTools, this.readArtifact];
    const agent = createAgent({
      model: this.deps.models.chatModel(tier),
      tools,
      systemPrompt: buildSystemPrompt(card, skills, this.deps.home),
      responseFormat: toolStrategy(OutcomeResponseSchema),
      middleware: [
        createUiEventsMiddleware(resolved.model),
        this.loopGuard,
        modelCallLimitMiddleware({ runLimit: card.limits.modelCalls, exitBehavior: "end" }),
        toolCallLimitMiddleware({ runLimit: card.limits.toolCalls, exitBehavior: "end" }),
        ...(skillsMiddleware ? [skillsMiddleware] : []),
      ],
      contextSchema: AgentRunContext,
      name: card.id,
      // Each dispatch starts from a fresh conversation (keeps Gemini thought signatures intact, no cross-model history).
      checkpointer: false,
    });
    return agent as unknown as InvokableAgent;
  }

  get(agentId: string, tier: Tier, mcp?: AgentRunArgs["mcp"]): InvokableAgent {
    const key = `${agentId}@${tier}@${this.deps.configHash}@${mcp?.fingerprint ?? "none"}`;
    let agent = this.cache.get(key);
    if (agent) {
      // Refresh recency so the least recently used entry is the one evicted.
      this.cache.delete(key);
    } else {
      agent = this.build(agentId, tier, mcp?.tools ?? []);
      if (this.cache.size >= MAX_CACHED_AGENTS) this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(key, agent);
    return agent;
  }

  async run(args: AgentRunArgs): Promise<AgentRunResult> {
    const card = this.deps.agents.require(args.agentId);
    const agent = this.get(args.agentId, args.tier, args.mcp);
    const result = await agent.invoke(
      { messages: [new HumanMessage(args.prompt)] },
      {
        context: { dispatchId: args.dispatchId },
        signal: args.signal,
        callbacks: args.callbacks,
        recursionLimit: (card.limits.modelCalls + card.limits.toolCalls) * 3 + 10,
        runName: `agent:${card.id}`,
        metadata: { analytax_dispatch_id: args.dispatchId, analytax_agent_id: card.id, analytax_tier: args.tier },
      },
    );
    return {
      structured: (result.structuredResponse as TaskOutcomeWire | undefined) ?? null,
      messages: result.messages ?? [],
    };
  }
}
