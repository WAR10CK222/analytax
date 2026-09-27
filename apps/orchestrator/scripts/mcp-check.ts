/**
 * Connects to every enabled MCP server in config/mcp.yaml and lists the tools each one offers, the way agents would
 * see them. No model is called. Exits non-zero when a server that an agent card uses cannot be reached.
 * Usage: pnpm mcp:check
 */
import path from "node:path";
import { loadConfig } from "../src/config/load.js";

function loadEnv(): void {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
  } catch {
    // .env is optional
  }
}

async function main(): Promise<void> {
  loadEnv();
  process.env.ANALYTAX_TELEMETRY_ENABLED = "false";
  process.env.LOG_LEVEL ??= "error";
  const config = loadConfig();
  if (!config.mcp) {
    console.log("No config/mcp.yaml, so no MCP tool servers are configured.");
    return;
  }
  const { AgentRegistry } = await import("../src/agents/registry.js");
  const { McpHub } = await import("../src/mcp/hub.js");
  // Checked even in offline demo mode: this script is how you test servers without spending model calls.
  const hub = McpHub.create(config.mcp, { env: process.env, killSwitch: process.env.ANALYTAX_MCP_ENABLED === "false" });
  const agents = AgentRegistry.load(path.join(config.home, config.orchestrator.paths.agents), {
    toolNames: new Set(["web_search", "fetch_url", "calculator", "current_datetime"]),
    hasSkill: () => true,
    mcpServers: hub.serverIds(),
  });
  const cards = agents.list();
  if (!hub.enabled) console.log(`MCP is off: ${hub.disabledReason}`);

  let failures = 0;
  for (const id of hub.serverIds()) {
    const summary = await hub.reconnect(id, cards);
    if (!summary) continue;
    const users = summary.usedBy.map((use) => use.agentId).join(", ") || "no agents";
    console.log(`\n${summary.id} (${summary.title}) · ${summary.host ?? "?"} · used by ${users}`);
    if (summary.status === "connected") {
      console.log(`  ✔ connected over ${summary.activeTransport === "sse" ? "SSE" : "Streamable HTTP"}, ${summary.tools.length} tool(s)`);
      for (const tool of summary.tools) console.log(`    ${tool.exposedName.padEnd(40)} ${tool.description.slice(0, 90)}`);
      for (const skipped of summary.skippedTools) console.log(`    ⚠ skipped ${skipped.name}: ${skipped.reason}`);
      for (const warning of summary.guardWarnings) console.log(`    ⚠ ${warning}`);
      for (const use of summary.usedBy) for (const name of use.missing) console.log(`    ⚠ ${use.agentId} asks for "${name}", which this server does not offer`);
    } else {
      const reason = summary.lastError ?? summary.detail ?? summary.status;
      console.log(`  ${summary.status === "failed" ? "✖" : "·"} ${summary.status}: ${reason}`);
      if (summary.status === "failed" && summary.usedBy.length > 0) failures += 1;
    }
  }
  await hub.close();
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`✖ ${(error as Error).message}`);
  process.exitCode = 1;
});
