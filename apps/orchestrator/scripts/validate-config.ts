/**
 * Validates config/*.yaml, agent cards, skills and tool references without calling any model.
 * Usage: pnpm validate:config
 */
import path from "node:path";
import { TIERS } from "@analytax/contracts";
import { loadConfig } from "../src/config/load.js";
import { describeThinking, validateModelsConfig } from "../src/models/capabilities.js";

function loadEnv(): void {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
  } catch {
    // .env is optional for validation
  }
}

async function main(): Promise<void> {
  loadEnv();
  process.env.ANALYTAX_TELEMETRY_ENABLED = "false";
  process.env.LOG_LEVEL ??= "error";
  const config = loadConfig();
  console.log(`Config home: ${config.home}`);

  const models = validateModelsConfig(config.models);
  console.log("\nModel tiers:");
  for (const tier of TIERS) {
    const spec = config.models.tiers[tier];
    console.log(`  ${tier.padEnd(14)} ${spec.model} · ${describeThinking(spec.thinking)}${spec.alternate ? `  (alt: ${spec.alternate.model} · ${describeThinking(spec.alternate.thinking)})` : ""}`);
  }
  for (const warning of models.warnings) console.log(`  ⚠ ${warning}`);
  for (const error of models.errors) console.log(`  ✖ ${error}`);

  const { createDefaultDeps } = await import("../src/graph/deps.js");
  const deps = createDefaultDeps();
  console.log("\nSkills:");
  for (const skill of deps.skills.list()) console.log(`  ${skill.name.padEnd(22)} ${skill.resources.length} resource(s)`);
  for (const warning of deps.skills.warnings) console.log(`  ⚠ ${warning}`);

  console.log("\nAgents:");
  for (const card of deps.agents.list()) {
    console.log(`  ${card.id.padEnd(12)} tiers ${card.model.minTier}…${card.model.maxTier} (default ${card.model.defaultTier})`);
    console.log(`  ${"".padEnd(12)} capabilities: ${card.capabilities.join(", ")}`);
    console.log(`  ${"".padEnd(12)} tools: ${card.tools.join(", ") || "none"} · skills: ${card.skills.join(", ") || "none"}`);
  }

  // Configuration only: no network. `pnpm mcp:check` connects and lists tools.
  const mcp = deps.mcp.status(deps.agents.list());
  console.log(`\nTool servers (MCP)${mcp.enabled ? "" : `: off. ${mcp.disabledReason}`}`);
  if (mcp.servers.length === 0) console.log("  none configured");
  for (const server of mcp.servers) {
    const users = server.usedBy.map((use) => use.agentId).join(", ") || "no agents";
    console.log(`  ${server.id.padEnd(14)} ${server.status.padEnd(13)} ${server.host ?? "?"} · used by ${users}`);
    if (server.status === "misconfigured") console.log(`  ${"".padEnd(14)} ⚠ ${server.detail}`);
    const guards = deps.config.mcp?.servers[server.id]?.guards ?? {};
    for (const [tool, policies] of Object.entries(guards)) {
      console.log(`  ${"".padEnd(14)} guard ${tool}: ${Object.entries(policies).map(([arg, policy]) => `${arg} is ${policy}`).join(", ")} (verified on connect: pnpm mcp:check)`);
    }
  }

  if (models.errors.length > 0) process.exitCode = 1;
  else console.log("\n✔ Configuration is valid");
}

main().catch((error: unknown) => {
  console.error(`✖ ${(error as Error).message}`);
  process.exitCode = 1;
});
