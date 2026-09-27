import type { CatalogResponse, Tier } from "@analytax/contracts";
import { TIERS } from "@analytax/contracts";
import { Hono } from "hono";
import { computeRecursionLimit } from "./graph/build.js";
import { getDefaultDeps } from "./graph/deps.js";
import { describeThinking } from "./models/capabilities.js";

/** Custom routes mounted on the LangGraph Agent Server (langgraph.json → http.app). */
export const app = new Hono();

app.get("/analytax/health", (c) => c.json({ ok: true }));

app.get("/analytax/catalog", (c) => {
  const deps = getDefaultDeps();
  const { guards, hitl } = deps.config.orchestrator;
  const numericGuards = Object.fromEntries(Object.entries(guards).filter(([, value]) => typeof value === "number")) as Record<string, number>;
  const catalog: CatalogResponse = {
    agents: deps.agents.summaries(),
    skills: deps.skills.summaries(deps.config.home),
    tiers: TIERS.map((tier: Tier) => {
      const resolved = deps.models.resolve(tier);
      const alternate = deps.config.models.tiers[tier].alternate;
      return {
        tier,
        model: resolved.model,
        thinking: describeThinking(resolved.thinking, resolved.model),
        alternate: alternate ? `${alternate.model} · ${describeThinking(alternate.thinking, alternate.model)}` : null,
      };
    }),
    roles: deps.config.models.roles,
    guards: { ...numericGuards, recursionLimit: computeRecursionLimit(guards) },
    hitlDefaults: hitl,
    faultsEnabled: deps.faultsEnabled,
    mode: deps.offlineModels ? "offline" : "live",
    mcp: deps.mcp.status(deps.agents.list()),
  };
  return c.json(catalog);
});

/** MCP tool server status (no network: reports the last known state). */
app.get("/analytax/mcp", (c) => {
  const deps = getDefaultDeps();
  return c.json(deps.mcp.status(deps.agents.list()));
});

/** Connects to one server now (skipping any backoff) and returns its fresh status. */
app.post("/analytax/mcp/:id/reconnect", async (c) => {
  const deps = getDefaultDeps();
  const summary = await deps.mcp.reconnect(c.req.param("id"), deps.agents.list());
  if (!summary) return c.json({ error: "Unknown MCP server" }, 404);
  return c.json(summary);
});
