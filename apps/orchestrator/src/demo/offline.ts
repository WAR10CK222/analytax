import {
  emptyUsage,
  type IntentAnalysis,
  type PlanDraftWire,
  type PlanPatchWire,
  type PlanTaskWire,
  type SynthesisWire,
  type TaskOutcomeWire,
  type VerdictWire,
} from "@analytax/contracts";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { AgentRegistry } from "../agents/registry.js";
import type { AgentRunArgs, AgentRunResult, AgentRunner } from "../agents/runtime.js";
import { dispatchSessions } from "../agents/sessions.js";
import { isMcpRef } from "../mcp/refs.js";
import type { StructuredCall, StructuredInvoker, StructuredResult } from "../models/structured.js";

/*
 * OFFLINE DEMO MODE (ANALYTAX_OFFLINE_MODELS=true)
 * Deterministic stand-ins for every model call so the full server + UI flow (planning, parallel waves, events,
 * interrupts, demo faults, projections) can be exercised without a Gemini API key. Never used unless enabled.
 */

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const between = (min: number, max: number): number => min + Math.floor(Math.random() * (max - min));

const tag = (text: string, name: string): string => new RegExp(`<${name}>\\n?([\\s\\S]*?)\\n?</${name}>`).exec(text)?.[1]?.trim() ?? "";

const criteriaFrom = (prompt: string): string[] =>
  tag(prompt, "acceptance_criteria")
    .split("\n")
    .map((line) => line.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean);

function subjectsOf(query: string): string[] {
  const text = query.replace(/[?!]/g, " ").trim();
  const versus = text.split(/\s+(?:vs\.?|versus)\s+/i);
  if (versus.length >= 2) return versus.map((part) => part.split(/\s+/).slice(-3).join(" ")).slice(0, 3);
  const compare = /compare\s+(.+?)(?:\s+for\s+|\s+and\s+recommend|\s+to\s+|\.|$)/i.exec(text)?.[1];
  if (compare) {
    return compare
      .split(/,\s*|\s+and\s+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 3);
  }
  return [];
}

const planTask = (ref: string, title: string, capability: string, agentId: string, dependsOn: string[], instructions: string, critical = true): PlanTaskWire => ({
  ref,
  title,
  instructions,
  acceptanceCriteria: [`Delivers: ${title}`, "Grounded in the provided context"],
  checks: [],
  capability,
  agentId,
  complexity: "medium",
  dependsOn,
  contextFrom: [],
  critical,
  dependencyPolicy: "all",
});

export class OfflineStructuredInvoker implements StructuredInvoker {
  constructor(private readonly agents: AgentRegistry) {}

  async invoke<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
    await sleep(between(250, 700), call.signal);
    return {
      value: call.schema.parse(this.respond(call as StructuredCall<unknown>)),
      usage: { ...emptyUsage(), inputTokens: 800, outputTokens: 250, modelCalls: 1 },
      model: "offline-demo",
      tier: call.tier ?? "fast",
    };
  }

  private respond(call: StructuredCall<unknown>): unknown {
    switch (call.role) {
      case "intake":
        return this.intake(tag(call.user, "query"));
      case "planner":
        return this.plan(tag(call.user, "client_request"));
      case "replanner":
        return this.replan(call.user);
      case "judge":
        return this.judge(call.user);
      case "synthesizer":
        return this.synthesize(call.user);
      default:
        // Smoke tests and other ad-hoc calls: return a minimal object and let the schema decide.
        return { answer: "offline", confidence: 1 };
    }
  }

  private intake(query: string): IntentAnalysis {
    const complex = /\b(compare|versus|vs\.?|recommend|analy[sz]e|research|evaluate|strategy|report|plan)\b/i.test(query) || query.length > 140;
    return {
      goal: query.length > 140 ? `${query.slice(0, 137)}...` : query,
      intentType: complex ? "analysis" : "question",
      deliverable: { format: complex ? "recommendation with supporting comparison" : "direct answer", audience: "general", length: complex ? "medium" : "short" },
      constraints: [],
      complexity: complex ? "high" : "low",
      path: complex ? "plan" : "direct",
      suggestedCapability: complex ? "analysis" : "general_qa",
      ambiguity: { isAmbiguous: false, questions: [] },
    };
  }

  private plan(query: string): PlanDraftWire {
    const subjects = subjectsOf(query);
    const has = (id: string) => this.agents.has(id);
    const research = (subjects.length ? subjects : ["the topic"]).map((subject, index) =>
      planTask(`r${index + 1}`, `Research ${subject}`, "web_research", "researcher", [], `Gather current, sourced facts about ${subject} relevant to the client's request.`),
    );
    const tasks: PlanTaskWire[] = [...research];
    if (has("analyst")) tasks.push(planTask("a1", "Compare findings and recommend", "analysis", "analyst", research.map((task) => task.ref), "Compare the research results against the client's needs and recommend an option."));
    if (has("writer")) tasks.push(planTask("w1", "Write the recommendation brief", "writing", "writer", [has("analyst") ? "a1" : "r1"], "Write a concise brief that leads with the recommendation."));
    if (has("critic") && has("writer")) tasks.push(planTask("c1", "Review the brief", "review", "critic", ["w1"], "Review the brief for unsupported claims and gaps.", false));
    return {
      rationale: "Research each option in parallel, compare them, write the brief, then review it.",
      synthesisGuidance: "Lead with the recommendation, then the key comparison points.",
      tasks,
    };
  }

  private replan(prompt: string): PlanPatchWire {
    const failed = /<request id="[^"]+" trigger="(ladder_exhausted|upstream_failed)" task="(t\d+)">/.exec(prompt);
    if (failed?.[2]) {
      return {
        diagnosis: `Retrying ${failed[2]} with a narrower scope.`,
        giveUp: false,
        ops: [{ op: "retry_task", reason: "narrow the scope", taskId: failed[2], dependsOn: "", tasks: [], instructions: "Narrow the scope to the essential facts and state assumptions explicitly.", agentId: "", waitFor: [] }],
      };
    }
    return { diagnosis: "No safe automatic patch in offline demo mode.", giveUp: true, ops: [] };
  }

  private judge(prompt: string): VerdictWire {
    const flawed = prompt.includes("(demo fault)");
    return {
      criteria: criteriaFrom(prompt).map((criterion) => ({ criterion, met: !flawed, note: flawed ? "The draft is intentionally incomplete" : "Satisfied" })),
      issues: flawed ? [{ severity: "major", text: "The draft ignores the acceptance criteria" }] : [],
      decision: flawed ? "revise" : "accept",
      score: flawed ? 0.3 : 0.88,
      feedback: flawed ? "Address every acceptance criterion explicitly." : "",
      missingPrerequisite: "",
    };
  }

  private synthesize(prompt: string): SynthesisWire {
    const request = tag(prompt, "client_request");
    const results = [...prompt.matchAll(/<result n="\d+" title="([^"]+)"[^>]*>\n<summary>([\s\S]*?)<\/summary>/g)].map((match) => `- **${match[1]}:** ${match[2]}`);
    const gaps = tag(prompt, "gaps");
    return {
      answer: `**Offline demo answer** for: _${request}_\n\n${results.join("\n")}\n\n> Produced in offline demo mode (no model calls). Set \`GOOGLE_API_KEY\` and \`ANALYTAX_OFFLINE_MODELS=false\` for real answers.`,
      limitations: gaps
        ? gaps
            .split("\n")
            .map((line) => line.replace(/^-\s*/, "").trim())
            .filter(Boolean)
        : [],
    };
  }
}

export class OfflineAgentRunner implements AgentRunner {
  constructor(private readonly agents: AgentRegistry) {}

  async run(args: AgentRunArgs): Promise<AgentRunResult> {
    const card = this.agents.require(args.agentId);
    const session = dispatchSessions.get(args.dispatchId);
    const title = tag(args.prompt, "title");
    const upstream = [...args.prompt.matchAll(/<result [^>]*title="([^"]+)"[^>]*>\n<summary>([\s\S]*?)<\/summary>/g)].map((match) => `${match[1]}: ${match[2]}`);
    const usage = { ...emptyUsage(), inputTokens: 1200, outputTokens: 400, reasoningTokens: 120, modelCalls: 1 };

    const skill = card.skills[0];
    if (skill) session?.emit("agent.skill.loaded", { skill });
    session?.emit("agent.model.started", { model: "offline-demo", callIndex: 0 });
    session?.emit("agent.thought", { text: `Working out how to approach "${title}" as ${card.name}.` });
    await sleep(between(500, 1200), args.signal);
    const tool = card.tools.find((name) => !isMcpRef(name));
    session?.emit("agent.model.finished", { model: "offline-demo", callIndex: 0, durationMs: 800, usage, toolCalls: tool ? [tool] : [] });
    if (tool) {
      const callId = `${args.dispatchId}:tool`;
      session?.emit("agent.tool.started", { tool, callId, args: JSON.stringify({ query: title }) });
      await sleep(between(400, 900), args.signal);
      session?.emit("agent.tool.finished", { tool, callId, ok: true, durationMs: 600, preview: `Offline result for "${title}"` });
    }
    await sleep(between(300, 800), args.signal);

    const research = card.capabilities.includes("web_research");
    const structured: TaskOutcomeWire = {
      status: "completed",
      summary: `${card.name} completed "${title}"${upstream.length ? ` using ${upstream.length} upstream result(s)` : ""}.`,
      output: `### ${title}\n\n${upstream.length ? `Inputs considered:\n${upstream.map((entry) => `- ${entry}`).join("\n")}\n\n` : ""}Placeholder content from the ${card.name} in offline demo mode. It exercises planning, context hand-off, evaluation and the UI without calling Gemini.`,
      keyFindings: [`${title}: offline finding`],
      sources: research ? [{ title: `Offline source for ${title}`, url: `https://example.com/${encodeURIComponent(title.toLowerCase().replace(/\s+/g, "-"))}` }] : [],
      confidence: 0.85,
      assumptions: ["Offline demo mode: no real research was performed"],
      openQuestions: [],
      proposals: [],
    };
    const message = new AIMessage({
      content: "",
      usage_metadata: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens, output_token_details: { reasoning: usage.reasoningTokens } },
    });
    return { structured, messages: [message] as BaseMessage[] };
  }
}
