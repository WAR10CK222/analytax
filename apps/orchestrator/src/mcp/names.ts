import { shortHash } from "../util/hash.js";

/** Gemini function names: start with a letter or underscore, then letters, digits, `_ . -`; at most 64 characters. */
export const GEMINI_FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const MAX_NAME = 64;

/**
 * The name an MCP tool is exposed under: `mcp__<server>__<tool>`, sanitized and capped for Gemini, and unique
 * among `taken`. Stable for the same inputs, so agent caches keyed on tool names stay valid across reconnects.
 */
export function exposedName(server: string, rawTool: string, taken: ReadonlySet<string>): string {
  const safeTool = rawTool.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/_{3,}/g, "__") || "tool";
  let name = `mcp__${server}__${safeTool}`;
  if (name.length > MAX_NAME) name = `${name.slice(0, MAX_NAME - 7)}_${shortHash(`${server}/${rawTool}`, 6)}`;
  if (taken.has(name)) name = `${name.slice(0, MAX_NAME - 7)}_${shortHash(`${server}/${rawTool}#dup`, 6)}`;
  return name;
}
