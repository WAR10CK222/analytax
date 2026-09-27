import { isCustomStreamChunk, type LifecycleEvent, type RunContext } from "@analytax/contracts";
import { HumanMessage } from "@langchain/core/messages";
import { Command, InMemoryStore, MemorySaver } from "@langchain/langgraph";
import type { AgentRunner } from "../../src/agents/runtime.js";
import type { AppConfig } from "../../src/config/load.js";
import { compileOrchestrator } from "../../src/graph/build.js";
import type { OrchestratorDeps } from "../../src/graph/deps.js";
import type { McpHub } from "../../src/mcp/hub.js";
import type { State } from "../../src/graph/state.js";
import { resolveTier, type ModelFactory } from "../../src/models/factory.js";
import type { StructuredInvoker } from "../../src/models/structured.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Clock } from "../../src/util/clock.js";
import { testAgents, testConfig, testMcpHub } from "../helpers.js";

export type TestDepsOptions = {
  structured: StructuredInvoker;
  agentRunner: AgentRunner;
  configure?: (config: AppConfig) => AppConfig;
  faultsEnabled?: boolean;
  clock?: Clock;
  resolveHook?: () => void;
  mcp?: McpHub;
};

export function createTestDeps(options: TestDepsOptions): OrchestratorDeps {
  const base = testConfig();
  const config = options.configure ? options.configure(structuredClone(base)) : base;
  const models: ModelFactory = {
    resolve: (tier) => {
      options.resolveHook?.();
      return resolveTier(config.models, tier);
    },
    chatModel: () => {
      throw new Error("Scenario tests use scripted agent runners, not chat models");
    },
  };
  return {
    config,
    agents: testAgents(),
    skills: SkillRegistry.discover(config.home, config.orchestrator.paths.skills),
    tools: new ToolRegistry({}),
    models,
    structured: options.structured,
    agentRunner: options.agentRunner,
    mcp: options.mcp ?? testMcpHub(),
    clock: options.clock ?? { now: () => new Date() },
    faultsEnabled: options.faultsEnabled ?? false,
    offlineModels: false,
  };
}

export type RunHandle = {
  graph: ReturnType<typeof compileOrchestrator>;
  config: { configurable: { thread_id: string } };
  custom: LifecycleEvent[];
  state(): Promise<State>;
  interrupts(): Promise<unknown[]>;
  resume(value: unknown): Promise<void>;
};

async function drain(graph: RunHandle["graph"], input: unknown, config: RunHandle["config"], custom: LifecycleEvent[]): Promise<void> {
  const stream = await graph.stream(input as never, { ...config, streamMode: ["custom", "updates"] });
  for await (const chunk of stream) {
    const [mode, data] = chunk as unknown as [string, unknown];
    if (mode === "custom" && isCustomStreamChunk(data)) custom.push(data.event);
  }
}

export async function startRun(deps: OrchestratorDeps, query: string, runOptions: RunContext | null = null, threadId = "test-thread"): Promise<RunHandle> {
  const graph = compileOrchestrator(deps, { checkpointer: new MemorySaver(), store: new InMemoryStore() });
  const config = { configurable: { thread_id: threadId } };
  const custom: LifecycleEvent[] = [];
  await drain(graph, { messages: [new HumanMessage(query)], runOptions }, config, custom);
  return {
    graph,
    config,
    custom,
    state: async () => (await graph.getState(config)).values as State,
    interrupts: async () => {
      const snapshot = await graph.getState(config);
      return snapshot.tasks.flatMap((task) => task.interrupts.map((entry) => entry.value));
    },
    resume: async (value: unknown) => drain(graph, new Command({ resume: value }), config, custom),
  };
}

export const eventTypes = (state: State): string[] => (state.events as LifecycleEvent[]).map((event) => event.type);

export const eventsOf = <T extends LifecycleEvent["type"]>(state: State, type: T): Extract<LifecycleEvent, { type: T }>[] =>
  (state.events as LifecycleEvent[]).filter((event): event is Extract<LifecycleEvent, { type: T }> => event.type === type);
