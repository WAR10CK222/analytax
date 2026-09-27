import type { RunToolServer } from "@analytax/contracts";
import type { AgentCard } from "../agents/registry.js";
import { matchesRef, splitToolRefs } from "./refs.js";

const MAX_LISTED = 8;

/**
 * One card's tools for the planner, as they stand in this run: built-in names, then the MCP tools it can actually
 * use, or "unavailable this run" so the planner routes work elsewhere.
 */
export function describeCardTools(card: AgentCard, servers: readonly RunToolServer[] | undefined): string {
  const { builtin, mcp } = splitToolRefs(card.tools);
  const parts = [...builtin];
  for (const id of [...new Set(mcp.map((ref) => ref.server))]) {
    const snapshot = servers?.find((server) => server.id === id);
    if (!snapshot) {
      parts.push(...mcp.filter((ref) => ref.server === id).map((ref) => ref.ref));
      continue;
    }
    if (snapshot.status !== "connected") {
      parts.push(`${id} tools: unavailable this run`);
      continue;
    }
    const refs = mcp.filter((ref) => ref.server === id);
    const names = snapshot.tools.filter((tool) => refs.some((ref) => matchesRef(ref, tool)));
    const listed = names.slice(0, MAX_LISTED).join(", ");
    parts.push(`${snapshot.title} tools (mcp__${id}__*): ${listed || "none"}${names.length > MAX_LISTED ? `, and ${names.length - MAX_LISTED} more` : ""}`);
  }
  return parts.length ? parts.join(", ") : "none";
}
