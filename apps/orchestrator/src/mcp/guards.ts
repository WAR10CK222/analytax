import type { McpArgPolicy, ResolvedServer } from "./config.js";
import { checkReadOnlySql } from "./sql-guard.js";

export type GuardRefusal = { tool: string; arg: string; policy: McpArgPolicy; reason: string; value: string };

const POLICIES: Record<McpArgPolicy, (value: string) => { ok: true } | { ok: false; reason: string }> = {
  "read-only-sql": checkReadOnlySql,
};

const DESCRIPTION: Record<McpArgPolicy, string> = {
  "read-only-sql": "must be a single read-only statement (SELECT, WITH, EXPLAIN, SHOW, TABLE or VALUES)",
};

/**
 * Applies the server's configured argument policies to one tool call. Returns the first refusal, or null when the
 * call may proceed. Arguments the policy names but the call omits pass; a non-string value is refused, because every
 * policy reads text.
 */
export function checkGuards(server: ResolvedServer, tool: string, args: Record<string, unknown>): GuardRefusal | null {
  const policies = server.guards[tool];
  if (!policies) return null;
  for (const [arg, policy] of Object.entries(policies)) {
    if (!(arg in args) || args[arg] === undefined || args[arg] === null) continue;
    const value = args[arg];
    if (typeof value !== "string") return { tool, arg, policy, reason: `"${arg}" must be text`, value: String(value) };
    const result = POLICIES[policy](value);
    if (!result.ok) return { tool, arg, policy, reason: result.reason, value };
  }
  return null;
}

/** What the agent is told. It starts with "Error" so the UI marks the tool call failed (see agents/middleware.ts). */
export const guardMessage = (serverTitle: string, refusal: GuardRefusal): string =>
  `Error from ${serverTitle}: blocked by the ${refusal.policy} guard on ${refusal.tool}. The "${refusal.arg}" argument ${DESCRIPTION[refusal.policy]}: ${refusal.reason}. Rewrite it as a read-only query.`;

/** Guards that name a tool or argument the connected server does not offer, so a typo cannot silently do nothing. */
export function guardWarnings(server: ResolvedServer, offered: ReadonlyMap<string, ReadonlySet<string>>, exposed: ReadonlySet<string>): string[] {
  const warnings: string[] = [];
  for (const [tool, policies] of Object.entries(server.guards)) {
    const args = offered.get(tool);
    if (!args) {
      warnings.push(`guard on "${tool}": this server does not offer that tool`);
      continue;
    }
    if (!exposed.has(tool)) warnings.push(`guard on "${tool}": the tool is filtered out by tools.include or tools.exclude, so the guard never runs`);
    for (const arg of Object.keys(policies)) {
      if (!args.has(arg)) warnings.push(`guard on "${tool}": the tool has no "${arg}" argument`);
    }
  }
  return warnings;
}
