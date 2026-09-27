import type { McpServerStatus, McpServerSummary, McpStatus, RunToolServer, RunToolServerStatus } from "@analytax/contracts";
import { asSentence } from "../lib/format";
import { tone, type Tone } from "../lib/status";

export const MCP_SERVER_TONE: Record<McpServerStatus, Tone> = {
  connected: tone("Connected", "success"),
  connecting: tone("Connecting", "running"),
  idle: tone("Not connected yet", "neutral", "waiting"),
  failed: tone("Unreachable", "danger"),
  misconfigured: tone("Needs setup", "attention"),
  disabled: tone("Off", "neutral", "canceled"),
};

export const RUN_TOOL_SERVER_TONE: Record<RunToolServerStatus, Tone> = {
  connected: tone("Connected", "success"),
  unavailable: tone("Unavailable", "attention"),
  misconfigured: tone("Needs setup", "attention"),
  disabled: tone("Off in config", "neutral", "canceled"),
  off: tone("Off for this run", "neutral", "canceled"),
};

const MCP_REF = /^mcp:([a-z][a-z0-9-]{0,23})\/(.+)$/;

export type AgentToolGroups = {
  builtin: string[];
  /** `tools` holds tool names, or "All tools" when the card uses `mcp:<server>/*`. */
  servers: { id: string; title: string; tools: string[] }[];
};

/** An agent card's tools: built-in names first, then MCP tools grouped under their server's title. */
export function groupAgentTools(tools: readonly string[], servers: readonly McpServerSummary[] = []): AgentToolGroups {
  const builtin: string[] = [];
  const grouped = new Map<string, string[]>();
  for (const ref of tools) {
    const match = MCP_REF.exec(ref);
    if (!match) {
      builtin.push(ref);
      continue;
    }
    const list = grouped.get(match[1]!) ?? [];
    list.push(match[2] === "*" ? "All tools" : match[2]!);
    grouped.set(match[1]!, list);
  }
  return {
    builtin,
    servers: [...grouped.entries()].map(([id, names]) => ({ id, title: servers.find((server) => server.id === id)?.title ?? id, tools: names })),
  };
}

export type ServerSwitch = { id: string; title: string; usable: boolean; tone: Tone; hint: string };

/** The tool servers agents use, as per-run switches. Servers no agent uses are left out. */
export function serverSwitches(status: McpStatus | undefined, agentName: (id: string) => string = (id) => id): ServerSwitch[] {
  if (!status?.enabled) return [];
  return status.servers
    .filter((server) => server.usedBy.length > 0)
    .map((server) => {
      const usable = server.enabled && server.status !== "misconfigured";
      const users = server.usedBy.map((use) => agentName(use.agentId)).join(", ");
      return {
        id: server.id,
        title: server.title,
        usable,
        tone: MCP_SERVER_TONE[server.status],
        hint: usable ? `Used by ${users}.${server.status === "failed" ? " Unreachable at the moment." : ""}` : asSentence(server.detail ?? MCP_SERVER_TONE[server.status].label),
      };
    });
}

/** Per-run `runOptions.mcp`, or undefined when nothing is switched off. Unknown ids are dropped. */
export function toRunMcpOptions(off: readonly string[], switches: readonly ServerSwitch[]): { disabled: string[] } | undefined {
  const known = new Set(switches.map((entry) => entry.id));
  const disabled = off.filter((id) => known.has(id));
  return disabled.length > 0 ? { disabled } : undefined;
}

/** "DeepWiki: connected; GitHub: off for this run" for the Usage tab. */
export function describeRunToolServers(servers: readonly RunToolServer[] | null | undefined): string | null {
  if (!servers || servers.length === 0) return null;
  return servers.map((server) => `${server.title}: ${RUN_TOOL_SERVER_TONE[server.status].label.toLowerCase()}`).join("; ");
}
