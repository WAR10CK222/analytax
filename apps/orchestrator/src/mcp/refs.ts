/**
 * Agent cards list tools by name. Built-in tools use their plain name; MCP tools use `mcp:<server>/<tool>` or
 * `mcp:<server>/*` for every tool the server allows.
 */
export type ToolRef =
  | { kind: "builtin"; ref: string; name: string }
  | { kind: "mcp"; ref: string; server: string; tool: string };

export type ToolRefResult = ToolRef | { kind: "invalid"; ref: string; reason: string };

const MCP_REF = /^mcp:([a-z][a-z0-9-]{0,23})\/(\*|[^\s*]+)$/;

export function parseToolRef(ref: string): ToolRefResult {
  if (!ref.startsWith("mcp:")) return { kind: "builtin", ref, name: ref };
  const match = MCP_REF.exec(ref);
  if (!match) return { kind: "invalid", ref, reason: `expected mcp:<server>/<tool> or mcp:<server>/*` };
  return { kind: "mcp", ref, server: match[1]!, tool: match[2]! };
}

export const isMcpRef = (ref: string): boolean => ref.startsWith("mcp:");

/** Refs of one card, split by kind (invalid refs are dropped; the registry rejects them at load). */
export function splitToolRefs(refs: readonly string[]): { builtin: string[]; mcp: Extract<ToolRef, { kind: "mcp" }>[] } {
  const builtin: string[] = [];
  const mcp: Extract<ToolRef, { kind: "mcp" }>[] = [];
  for (const ref of refs) {
    const parsed = parseToolRef(ref);
    if (parsed.kind === "builtin") builtin.push(parsed.name);
    else if (parsed.kind === "mcp") mcp.push(parsed);
  }
  return { builtin, mcp };
}

export const matchesRef = (ref: Extract<ToolRef, { kind: "mcp" }>, toolName: string): boolean => ref.tool === "*" || ref.tool === toolName;

/** The server-side allow and deny lists from config/mcp.yaml. */
export const serverAllows = (include: readonly string[] | null, exclude: readonly string[], toolName: string): boolean =>
  (include === null || include.includes(toolName)) && !exclude.includes(toolName);

/** Server ids referenced by any of the given cards, sorted. */
export const referencedServers = (cards: readonly { tools: readonly string[] }[]): string[] =>
  [...new Set(cards.flatMap((card) => splitToolRefs(card.tools).mcp.map((ref) => ref.server)))].sort();
