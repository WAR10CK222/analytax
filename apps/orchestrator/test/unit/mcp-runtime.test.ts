import { BaseChatModel, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { OUTCOME_TOOL_NAME, buildSystemPrompt } from "../../src/agents/prompt.js";
import { AgentRuntimes } from "../../src/agents/runtime.js";
import { dispatchSessions } from "../../src/agents/sessions.js";
import { McpConfig } from "../../src/mcp/config.js";
import { McpHub } from "../../src/mcp/hub.js";
import { resolveTier, type ModelFactory } from "../../src/models/factory.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { startTestMcpServer } from "../harness/mcp-server.js";
import { testAgents, testConfig } from "../helpers.js";

type Script = (messages: BaseMessage[], toolNames: string[]) => AIMessage;

class ScriptedChatModel extends BaseChatModel {
  constructor(
    private readonly script: Script,
    readonly toolNames: string[] = [],
    private readonly onBind?: (names: string[]) => void,
  ) {
    super({});
  }

  _llmType(): string {
    return "scripted";
  }

  override bindTools(tools: BindToolsInput[]) {
    const names = tools.map((entry) => String((entry as { name?: string }).name ?? ""));
    this.onBind?.(names);
    return new ScriptedChatModel(this.script, names, this.onBind) as unknown as ReturnType<BaseChatModel["withConfig"]>;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.script(messages, this.toolNames);
    return { generations: [{ text: "", message }] };
  }
}

const fake = (name: string) => () => tool(async () => "ok", { name, description: name, schema: z.object({ q: z.string() }) });
const builtins = () => new ToolRegistry({ web_search: fake("web_search"), fetch_url: fake("fetch_url"), current_datetime: fake("current_datetime"), calculator: fake("calculator") });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("MCP tools inside an agent run", () => {
  it("binds the dispatch's MCP tools, calls them and frames their output", async () => {
    const server = await startTestMcpServer();
    cleanups.push(() => server.close());
    const hub = McpHub.create(McpConfig.parse({ servers: { example: { url: server.url } } }), { env: {} });
    cleanups.push(() => hub.close());

    const card = { ...testAgents().require("researcher"), tools: ["web_search", "mcp:example/echo"] };
    const mcp = await hub.toolsFor(card, new Set(), { waitMs: 3_000 });
    expect(mcp.tools.map((entry) => entry.name)).toEqual(["mcp__example__echo"]);

    const config = testConfig();
    let bound: string[] = [];
    const script: Script = (messages, toolNames) => {
      const turn = messages.filter((message) => message.type === "ai").length;
      if (turn === 0) return new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "mcp__example__echo", args: { text: "from mcp" } }] });
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "c2",
            name: toolNames.find((name) => name === OUTCOME_TOOL_NAME) ?? OUTCOME_TOOL_NAME,
            args: { status: "completed", summary: "Echoed.", output: "Echoed.", keyFindings: [], sources: [], confidence: 0.9, assumptions: [], openQuestions: [], proposals: [] },
          },
        ],
      });
    };
    const models: ModelFactory = { resolve: (tier) => resolveTier(config.models, tier), chatModel: () => new ScriptedChatModel(script, [], (names) => (bound = names)) };
    const runtimes = new AgentRuntimes({ agents: testAgents(), skills: SkillRegistry.discover(config.home, []), tools: builtins(), models, home: config.home, configHash: "test" });

    const release = dispatchSessions.register({ dispatchId: "t1.a1.w1", emit: () => undefined, artifacts: new Map(), readArtifact: async () => "" });
    try {
      const result = await runtimes.run({
        agentId: "researcher",
        tier: "standard",
        dispatchId: "t1.a1.w1",
        signal: AbortSignal.timeout(10_000),
        prompt: "<task>Echo</task>",
        mcp: { tools: mcp.tools, fingerprint: mcp.fingerprint },
      });
      expect(bound).toContain("mcp__example__echo");
      expect(bound.some((name) => name.startsWith("mcp__deepwiki"))).toBe(false);
      const toolMessage = result.messages.find((message) => message.type === "tool" && message.name === "mcp__example__echo");
      expect(String(toolMessage?.content)).toContain('<tool_output server="example" tool="echo" trust="untrusted">');
      expect(String(toolMessage?.content)).toContain("from mcp");
      expect(result.structured).toMatchObject({ status: "completed" });
    } finally {
      release();
    }
  });

  it("rebuilds a cached agent only when the MCP tool set changes", () => {
    const config = testConfig();
    const models: ModelFactory = { resolve: (tier) => resolveTier(config.models, tier), chatModel: () => new ScriptedChatModel(() => new AIMessage("")) };
    const runtimes = new AgentRuntimes({ agents: testAgents(), skills: SkillRegistry.discover(config.home, []), tools: builtins(), models, home: config.home, configHash: "test" });
    const first = runtimes.get("researcher", "standard", { tools: [], fingerprint: "a" });
    expect(runtimes.get("researcher", "standard", { tools: [], fingerprint: "a" })).toBe(first);
    expect(runtimes.get("researcher", "standard", { tools: [], fingerprint: "b" })).not.toBe(first);
  });

  it("tells cards with MCP tools that tool output is untrusted", () => {
    const researcher = testAgents().require("researcher");
    expect(buildSystemPrompt(researcher, [], testConfig().home)).toContain('trust="untrusted"');
    expect(buildSystemPrompt(testAgents().require("writer"), [], testConfig().home)).not.toContain("External tools");
  });
});
