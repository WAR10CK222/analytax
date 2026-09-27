import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { usageFromMessage } from "../models/usage.js";
import { stableStringify } from "../util/hash.js";
import { truncate } from "../util/text.js";
import { dispatchSessions } from "./sessions.js";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : typeof block?.text === "string" ? block.text : ""))
      .join("");
  }
  return "";
}

/** Thought summaries from Gemini (`reasoning` standard blocks, or raw `thought: true` parts). */
export function extractThoughts(message: BaseMessage): string[] {
  const thoughts: string[] = [];
  try {
    const blocks = (message as unknown as { contentBlocks?: { type: string; reasoning?: string }[] }).contentBlocks ?? [];
    for (const block of blocks) if (block.type === "reasoning" && block.reasoning?.trim()) thoughts.push(block.reasoning.trim());
  } catch {
    // contentBlocks can throw for unusual content; fall back to raw parts below.
  }
  if (thoughts.length === 0 && Array.isArray(message.content)) {
    for (const part of message.content as { thought?: boolean; text?: string }[]) {
      if (part?.thought && part.text?.trim()) thoughts.push(part.text.trim());
    }
  }
  return thoughts;
}

/** Streams model/tool/thought activity of a running agent to the UI as ephemeral events. */
export function createUiEventsMiddleware(model: string) {
  return createMiddleware({
    name: "AnalytaxUiEvents",
    wrapModelCall: async (request, handler) => {
      const session = dispatchSessions.fromRuntime(request.runtime);
      const callIndex = request.messages.filter((message) => message.type === "ai").length;
      const started = Date.now();
      session?.emit("agent.model.started", { model, callIndex });
      const response = await handler(request);
      if (session && AIMessage.isInstance(response)) {
        session.emit("agent.model.finished", {
          model,
          callIndex,
          durationMs: Date.now() - started,
          usage: usageFromMessage(response),
          toolCalls: (response.tool_calls ?? []).map((call) => call.name),
        });
        for (const thought of extractThoughts(response).slice(0, 3)) session.emit("agent.thought", { text: truncate(thought, 800) });
      }
      return response;
    },
    wrapToolCall: async (request, handler) => {
      const session = dispatchSessions.fromRuntime(request.runtime);
      const name = request.toolCall.name;
      const callId = request.toolCall.id ?? null;
      session?.emit("agent.tool.started", { tool: name, callId, args: truncate(JSON.stringify(request.toolCall.args), 400) });
      const started = Date.now();
      try {
        const result = await handler(request);
        if (session) {
          const isMessage = ToolMessage.isInstance(result);
          session.emit("agent.tool.finished", {
            tool: name,
            callId,
            ok: !isMessage || (result.status !== "error" && !textOf(result.content).startsWith("Error")),
            durationMs: Date.now() - started,
            preview: isMessage ? truncate(textOf(result.content), 400) : "(command)",
          });
        }
        return result;
      } catch (error) {
        session?.emit("agent.tool.finished", {
          tool: name,
          callId,
          ok: false,
          durationMs: Date.now() - started,
          preview: truncate((error as Error).message ?? String(error), 400),
        });
        throw error;
      }
    },
  });
}

/**
 * Intra-task loop guard: fingerprints (tool, args) over recent tool calls. The 3rd identical call gets a warning
 * appended; the 5th is refused with an instruction to change approach or submit.
 */
export function createToolLoopGuardMiddleware(options: { warnAt?: number; stopAt?: number; window?: number } = {}) {
  const warnAt = options.warnAt ?? 3;
  const stopAt = options.stopAt ?? 5;
  const window = options.window ?? 16;
  return createMiddleware({
    name: "ToolLoopGuard",
    wrapToolCall: async (request, handler) => {
      const fingerprint = `${request.toolCall.name}:${stableStringify(request.toolCall.args)}`;
      const recent = (request.state.messages ?? []).filter((message: BaseMessage) => message.type === "ai").slice(-window);
      let occurrences = 0;
      for (const message of recent) {
        for (const call of (message as AIMessage).tool_calls ?? []) {
          if (`${call.name}:${stableStringify(call.args)}` === fingerprint) occurrences++;
        }
      }
      const toolCallId = request.toolCall.id ?? "";
      if (occurrences >= stopAt) {
        return new ToolMessage({
          tool_call_id: toolCallId,
          name: request.toolCall.name,
          status: "error",
          content:
            `LOOP DETECTED: this exact ${request.toolCall.name} call was made ${occurrences} times. It will not run again. ` +
            "Change your approach, or submit your outcome now (use status 'partial' or 'blocked' and explain what is missing).",
        });
      }
      const result = await handler(request);
      if (occurrences >= warnAt && ToolMessage.isInstance(result)) {
        return new ToolMessage({
          tool_call_id: result.tool_call_id,
          name: result.name,
          status: result.status,
          content: `${textOf(result.content)}\n\n[Warning: you have repeated this exact call ${occurrences} times. Do not repeat it again.]`,
        });
      }
      return result;
    },
  });
}

/** `read_artifact`: lets an agent pull the full output of an upstream task that only appears as a summary. */
export function createReadArtifactTool() {
  return tool(
    async ({ key, offset, limit }, runtime) => {
      const session = dispatchSessions.fromRuntime(runtime);
      if (!session) return "Artifacts are unavailable in this context.";
      const ref = session.artifacts.get(key);
      if (!ref) {
        const available = [...session.artifacts.keys()];
        return `Unknown artifact '${key}'. Available: ${available.length ? available.join(", ") : "none"}`;
      }
      const text = await session.readArtifact(ref);
      const start = Math.max(0, offset);
      const end = Math.min(text.length, start + Math.min(Math.max(limit, 500), 20_000));
      return `${text.slice(start, end)}\n\n[artifact ${key}: characters ${start}-${end} of ${text.length}]`;
    },
    {
      name: "read_artifact",
      description:
        "Read the full output of an upstream task when its summary in <upstream> is not enough. " +
        "Use the artifact key shown on the <result> element.",
      schema: z.object({
        key: z.string().describe("Artifact key from <upstream>, e.g. 't2/a1'"),
        offset: z.number().int().describe("Character offset to start from (0 for the beginning)"),
        limit: z.number().int().describe("Characters to read (500-20000)"),
      }),
    },
  );
}
