import type { PlanDraftWire } from "@analytax/contracts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveRunOptions } from "../../src/graph/run-options.js";
import { McpConfig } from "../../src/mcp/config.js";
import { McpHub } from "../../src/mcp/hub.js";
import { startTestMcpServer } from "../harness/mcp-server.js";
import { createTestDeps, eventsOf, startRun } from "../harness/run.js";
import { ScriptedAgentRunner, ScriptedStructuredInvoker, wireOutcome } from "../harness/scripted.js";
import { testConfig } from "../helpers.js";

// The repo's researcher card lists `mcp:deepwiki/ask_wiki_question`, so these tests serve a stand-in "deepwiki".
const plan: PlanDraftWire = {
  rationale: "Research, then write.",
  synthesisGuidance: "Answer directly.",
  tasks: [
    {
      ref: "r1",
      title: "Research the repository",
      instructions: "Find out how it works.",
      acceptanceCriteria: ["Explains it"],
      checks: [],
      capability: "web_research",
      agentId: "researcher",
      complexity: "medium",
      dependsOn: [],
      contextFrom: [],
      critical: true,
      dependencyPolicy: "all",
    },
  ],
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function closedUrl(): Promise<string> {
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  await new Promise<void>((resolve) => http.close(() => resolve()));
  return `http://127.0.0.1:${port}/mcp`;
}

function hub(url: string): McpHub {
  const created = McpHub.create(McpConfig.parse({ servers: { deepwiki: { url, title: "DeepWiki" } } }), { env: {} });
  cleanups.push(() => created.close());
  return created;
}

function setup(mcp: McpHub) {
  const structured = new ScriptedStructuredInvoker({ planner: () => plan });
  const agents = new ScriptedAgentRunner(() => wireOutcome());
  return { structured, agents, deps: createTestDeps({ structured, agentRunner: agents, mcp }) };
}

describe("MCP tool servers in a run", () => {
  it("hands connected MCP tools to the agents that list them and records the snapshot", async () => {
    const server = await startTestMcpServer({
      register: (mcp) =>
        mcp.registerTool("ask_wiki_question", { description: "Ask about a repo.", inputSchema: { repoName: z.string(), question: z.string() } }, async () => ({
          content: [{ type: "text", text: "answer" }],
        })),
    });
    cleanups.push(() => server.close());
    const { structured, agents, deps } = setup(hub(server.url));

    const state = await (await startRun(deps, "How does the repo work?", null, "mcp-connected")).state();
    expect(state.final?.status).toBe("complete");
    // The snapshot lists everything the server allows; each card still only gets the tools it names.
    expect(state.run.toolServers).toEqual([{ id: "deepwiki", title: "DeepWiki", status: "connected", toolCount: 4, tools: ["echo", "slow", "fail", "ask_wiki_question"], detail: null }]);
    expect(eventsOf(state, "run.started")[0]?.data.toolServers?.[0]?.status).toBe("connected");
    expect(agents.calls.find((call) => call.agentId === "researcher")?.mcpTools).toEqual(["mcp__deepwiki__ask_wiki_question"]);
    // Agents that do not list MCP tools never get them.
    expect(agents.calls.filter((call) => call.agentId !== "researcher").every((call) => call.mcpTools.length === 0)).toBe(true);
    const planner = structured.calls.find((call) => call.role === "planner");
    expect(planner?.user ?? planner?.system).toBeTruthy();
    expect(`${planner?.system}\n${planner?.user}`).toContain("DeepWiki tools (mcp__deepwiki__*): ask_wiki_question");
  });

  it("finishes the run when a server is down, telling the planner and the agent", async () => {
    const { structured, agents, deps } = setup(hub(await closedUrl()));
    const handle = await startRun(deps, "How does the repo work?", null, "mcp-down");
    const state = await handle.state();

    expect(state.final?.status).toBe("complete");
    expect(state.run.toolServers?.[0]).toMatchObject({ id: "deepwiki", status: "unavailable" });
    const planner = structured.calls.find((call) => call.role === "planner");
    expect(`${planner?.system}\n${planner?.user}`).toContain("deepwiki tools: unavailable this run");
    const research = agents.calls.find((call) => call.agentId === "researcher");
    expect(research?.mcpTools).toEqual([]);
    expect(research?.prompt).toContain("## Unavailable tools");
    const started = handle.custom.find((event) => event.type === "agent.started" && event.agentId === "researcher");
    expect(started?.data).toMatchObject({ unavailableToolServers: ["deepwiki"] });
  });

  it("keeps a server out of one run when the run turns it off", async () => {
    const server = await startTestMcpServer();
    cleanups.push(() => server.close());
    const { agents, deps } = setup(hub(server.url));

    const state = await (await startRun(deps, "How does the repo work?", { mcp: { disabled: ["deepwiki"] } }, "mcp-off")).state();
    expect(state.run.toolServers?.[0]).toMatchObject({ id: "deepwiki", status: "off" });
    const research = agents.calls.find((call) => call.agentId === "researcher");
    expect(research?.mcpTools).toEqual([]);
    expect(research?.prompt).not.toContain("## Unavailable tools");
    expect(server.initializeCount()).toBe(0);
  });

  it("reads per-run MCP switches from the run input or the LangGraph context (Studio)", () => {
    const config = testConfig().orchestrator;
    expect(resolveRunOptions({ mcp: { disabled: ["deepwiki", "deepwiki"] } }, null, config, false).mcp).toEqual({ allOff: false, disabled: ["deepwiki"] });
    expect(resolveRunOptions(null, { mcp: { enabled: false } }, config, false).mcp).toEqual({ allOff: true, disabled: [] });
    expect(resolveRunOptions(null, null, config, false).mcp).toEqual({ allOff: false, disabled: [] });
  });
});
