import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";

const MAX_DESCRIPTION = 1_000;
const MAX_ERROR = 2_000;

/** Tool descriptions come from the server, so they are untrusted: strip control characters and cap them. */
export function toolDescription(serverTitle: string, raw: string | undefined): string {
  const clean = (raw ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim();
  const text = `[${serverTitle}] ${clean || "Tool provided by an MCP server."}`;
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
}

/** Flattens MCP content blocks to text an LLM can read. Binary content is summarized, not inlined. */
export function resultText(result: CallToolResult): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "image":
        parts.push(`[image omitted: ${block.mimeType}]`);
        break;
      case "audio":
        parts.push(`[audio omitted: ${block.mimeType}]`);
        break;
      case "resource": {
        const resource = block.resource as { uri: string; text?: string };
        parts.push(typeof resource.text === "string" ? `Resource ${resource.uri}:\n${resource.text}` : `[binary resource omitted: ${resource.uri}]`);
        break;
      }
      case "resource_link":
        parts.push(`Link: ${block.name} (${block.uri})`);
        break;
      default:
        break;
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n\n").trim();
}

const escapeFrame = (text: string): string => text.replace(/<\/tool_output/gi, "<\\/tool_output");

/**
 * The text an agent receives. Successful output is framed as untrusted data (servers can return anything, including
 * text that looks like instructions); failures start with "Error", which the UI events middleware reports as failed.
 */
export function formatToolOutput(args: { serverId: string; serverTitle: string; tool: string; result: CallToolResult; maxChars: number }): string {
  const text = resultText(args.result);
  if (args.result.isError) {
    const detail = text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR - 1)}…` : text;
    return `Error from ${args.serverTitle}: ${detail || "the tool reported an error without details."}`;
  }
  const body = text.length > args.maxChars ? `${text.slice(0, args.maxChars)}\n…[output truncated at ${args.maxChars} characters]` : text;
  return `<tool_output server="${args.serverId}" tool="${args.tool}" trust="untrusted">\n${escapeFrame(body || "(no output)")}\n</tool_output>`;
}

export type McpToolInvoker = (args: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<string>;

/** A LangChain tool that forwards to the hub. The JSON schema was already rewritten for Gemini. */
export function createMcpTool(args: { name: string; description: string; schema: Record<string, unknown>; invoke: McpToolInvoker }): StructuredToolInterface {
  return tool(async (input: unknown, config) => args.invoke((input ?? {}) as Record<string, unknown>, config?.signal), {
    name: args.name,
    description: args.description,
    schema: args.schema,
  }) as unknown as StructuredToolInterface;
}
