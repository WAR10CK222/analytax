import path from "node:path";
import { AgentRegistry } from "../agents/registry.js";
import { AgentRuntimes, type AgentRunner } from "../agents/runtime.js";
import { ConfigError, loadConfig, type AppConfig } from "../config/load.js";
import { OfflineAgentRunner, OfflineStructuredInvoker } from "../demo/offline.js";
import { validateModelsConfig } from "../models/capabilities.js";
import { McpHub } from "../mcp/hub.js";
import { GeminiModelFactory, type ModelFactory } from "../models/factory.js";
import { ChatStructuredInvoker, type StructuredInvoker } from "../models/structured.js";
import { SkillRegistry } from "../skills/registry.js";
import { recordOperationDuration, recordTokenUsage } from "../telemetry/metrics.js";
import { createCalculatorTool } from "../tools/calculator.js";
import { createDatetimeTool } from "../tools/datetime.js";
import { createFetchUrlTool } from "../tools/fetch-url.js";
import { ToolRegistry } from "../tools/registry.js";
import { GeminiGroundedSearch, createWebSearchTool } from "../tools/web-search.js";
import { systemClock, type Clock } from "../util/clock.js";
import { logger } from "../util/logger.js";

export interface OrchestratorDeps {
  config: AppConfig;
  agents: AgentRegistry;
  skills: SkillRegistry;
  tools: ToolRegistry;
  models: ModelFactory;
  structured: StructuredInvoker;
  agentRunner: AgentRunner;
  /** MCP tool servers from config/mcp.yaml. Connects lazily; never starts or supervises server processes. */
  mcp: McpHub;
  clock: Clock;
  /** ANALYTAX_ENABLE_FAULTS=true — lets clients inject demo faults per run. */
  faultsEnabled: boolean;
  /** ANALYTAX_OFFLINE_MODELS=true — deterministic stand-in models, no Gemini calls. */
  offlineModels: boolean;
}

export function createDefaultDeps(): OrchestratorDeps {
  const config = loadConfig();
  const modelIssues = validateModelsConfig(config.models);
  for (const warning of modelIssues.warnings) logger.warn({ warning }, "model config");
  if (modelIssues.errors.length > 0) throw new ConfigError(`Invalid config/models.yaml:\n- ${modelIssues.errors.join("\n- ")}`);

  const models = new GeminiModelFactory(config.models);
  const skills = SkillRegistry.discover(config.home, config.orchestrator.paths.skills);
  for (const warning of skills.warnings) logger.warn({ warning }, "skills");

  const search = new GeminiGroundedSearch(
    () => models.resolve(config.models.roles.search),
    (result, durationMs) => {
      recordTokenUsage(result.usage, { model: result.model, operation: "chat" });
      recordOperationDuration(durationMs / 1000, { model: result.model, operation: "chat" });
    },
  );
  const tools = new ToolRegistry({
    web_search: () => createWebSearchTool(search),
    fetch_url: createFetchUrlTool,
    calculator: createCalculatorTool,
    current_datetime: createDatetimeTool,
  });
  const offline = process.env.ANALYTAX_OFFLINE_MODELS === "true";
  if (offline) logger.warn("ANALYTAX_OFFLINE_MODELS=true — using deterministic offline demo models (no Gemini calls)");

  const mcp = McpHub.create(config.mcp, { env: process.env, killSwitch: process.env.ANALYTAX_MCP_ENABLED === "false", offline });
  const agents = AgentRegistry.load(path.join(config.home, config.orchestrator.paths.agents), {
    toolNames: tools.names(),
    hasSkill: (name) => skills.has(name),
    mcpServers: mcp.serverIds(),
  });
  for (const server of mcp.status(agents.list()).servers) {
    if (server.status !== "connected" && server.status !== "idle" && server.usedBy.length > 0) {
      logger.warn({ server: server.id, status: server.status, detail: server.detail, agents: server.usedBy.map((use) => use.agentId) }, "mcp server used by agents is not usable");
    }
  }

  return {
    config,
    agents,
    skills,
    tools,
    models,
    structured: offline ? new OfflineStructuredInvoker(agents) : new ChatStructuredInvoker(models, config.models),
    agentRunner: offline
      ? new OfflineAgentRunner(agents)
      : new AgentRuntimes({ agents, skills, tools, models, home: config.home, configHash: config.hash }),
    mcp,
    clock: systemClock,
    faultsEnabled: process.env.ANALYTAX_ENABLE_FAULTS === "true",
    offlineModels: offline,
  };
}

let defaults: OrchestratorDeps | null = null;

/** Process-wide dependencies shared by the graph and the custom HTTP routes. */
export function getDefaultDeps(): OrchestratorDeps {
  defaults ??= createDefaultDeps();
  return defaults;
}
