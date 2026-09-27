import type { EphemeralEventType } from "@analytax/contracts";
import { BaseChatModel, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OUTCOME_TOOL_NAME } from "../../src/agents/prompt.js";
import { AgentRuntimes } from "../../src/agents/runtime.js";
import { dispatchSessions } from "../../src/agents/sessions.js";
import { resolveTier, type ModelFactory } from "../../src/models/factory.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { createCalculatorTool } from "../../src/tools/calculator.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { testAgents, testConfig } from "../helpers.js";

type Script = (messages: BaseMessage[], toolNames: string[]) => AIMessage;

/** Minimal chat model that replays a script; records the tools createAgent binds. */
class ScriptedChatModel extends BaseChatModel {
  constructor(
    private readonly script: Script,
    readonly toolNames: string[] = [],
  ) {
    super({});
  }

  _llmType(): string {
    return "scripted";
  }

  override bindTools(tools: BindToolsInput[]) {
    const names = tools.map((entry) => String((entry as { name?: string; function?: { name?: string } }).name ?? (entry as { function?: { name?: string } }).function?.name ?? ""));
    return new ScriptedChatModel(this.script, names) as unknown as ReturnType<BaseChatModel["withConfig"]>;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.script(messages, this.toolNames);
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] };
  }
}

describe("agent runtime (createAgent + middleware + skills)", () => {
  it("activates a skill, uses tools, streams UI events and submits a structured outcome", async () => {
    const config = testConfig();
    const skills = SkillRegistry.discover(config.home, config.orchestrator.paths.skills);
    const searches: string[] = [];
    const tools = new ToolRegistry({
      web_search: () =>
        tool(async ({ query }) => {
          searches.push(query);
          return "Vendor A costs $10/month [1]\n\nSources:\n[1] Vendor A pricing — https://a.example/pricing";
        }, { name: "web_search", description: "search", schema: z.object({ query: z.string() }) }),
      fetch_url: () => tool(async () => "page", { name: "fetch_url", description: "fetch", schema: z.object({ url: z.string(), maxChars: z.number() }) }),
      calculator: createCalculatorTool,
      current_datetime: () => tool(async () => "2026-09-10", { name: "current_datetime", description: "now", schema: z.object({ timeZone: z.string() }) }),
    });

    let outcomeToolName = "";
    const script: Script = (messages, toolNames) => {
      outcomeToolName = toolNames.find((name) => name === OUTCOME_TOOL_NAME || name.startsWith("extract")) ?? "";
      const turn = messages.filter((message) => message.type === "ai").length;
      if (turn === 0) return new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "activate_skill", args: { name: "web-research" } }] });
      if (turn === 1) return new AIMessage({ content: "", tool_calls: [{ id: "c2", name: "web_search", args: { query: "vendor A pricing 2026" } }] });
      return new AIMessage({
        content: "",
        usage_metadata: { input_tokens: 500, output_tokens: 120, total_tokens: 620, output_token_details: { reasoning: 40 } },
        tool_calls: [
          {
            id: "c3",
            name: outcomeToolName,
            args: {
              status: "completed",
              summary: "Vendor A costs $10/month.",
              output: "Vendor A lists a $10/month plan [1].",
              keyFindings: ["Vendor A: $10/month"],
              sources: [{ title: "Vendor A pricing", url: "https://a.example/pricing" }],
              confidence: 0.85,
              assumptions: [],
              openQuestions: [],
              proposals: [],
            },
          },
        ],
      });
    };
    const models: ModelFactory = { resolve: (tier) => resolveTier(config.models, tier), chatModel: () => new ScriptedChatModel(script) };
    const runtimes = new AgentRuntimes({ agents: testAgents(), skills, tools, models, home: config.home, configHash: "test" });

    const emitted: EphemeralEventType[] = [];
    const release = dispatchSessions.register({
      dispatchId: "t1.a1.w1",
      emit: (type) => emitted.push(type),
      artifacts: new Map(),
      readArtifact: async () => "",
    });
    try {
      const result = await runtimes.run({
        agentId: "researcher",
        tier: "standard",
        dispatchId: "t1.a1.w1",
        signal: AbortSignal.timeout(10_000),
        prompt: '<task id="t1" attempt="1" dispatch="t1.a1.w1" agent="researcher">\n<title>Find pricing</title>\n</task>',
      });

      expect(outcomeToolName).toBe(OUTCOME_TOOL_NAME);
      expect(result.structured).toMatchObject({ status: "completed", summary: "Vendor A costs $10/month." });
      expect(searches).toEqual(["vendor A pricing 2026"]);
      const skillMessage = result.messages.find((message) => message.type === "tool" && message.name === "activate_skill");
      expect(String(skillMessage?.content)).toContain('<skill_content name="web-research">');
      expect(emitted).toEqual(expect.arrayContaining(["agent.skill.loaded", "agent.tool.started", "agent.tool.finished", "agent.model.finished"]));
    } finally {
      release();
    }
  });
});
