import { referencedServers } from "../mcp/refs.js";
import { startTelemetry } from "../telemetry/instrument.js";
import { compileOrchestrator } from "./build.js";
import { getDefaultDeps } from "./deps.js";

// Entry point referenced by langgraph.json. The Agent Server supplies the checkpointer and store.
startTelemetry();

const deps = getDefaultDeps();
export const graph = compileOrchestrator(deps);

// Connect to the MCP servers agent cards use in the background, so the first run rarely waits for them.
deps.mcp.warmUp(referencedServers(deps.agents.list()));
