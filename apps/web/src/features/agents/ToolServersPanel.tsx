import type { AgentCardSummary, McpServerSummary, McpStatus } from "@analytax/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { Disclosure } from "../../components/ui/Disclosure";
import { IconRetry } from "../../components/ui/icons";
import { StatusBadge } from "../../components/ui/Status";
import { Callout, Card, KeyValues, Section } from "../../components/ui/Surface";
import { RelativeTime } from "../../components/ui/time";
import { notify } from "../../components/ui/Toast";
import { fetchMcpStatus, reconnectMcp } from "../../lib/api";
import { asSentence, errorMessage, formatRelativeTime, pluralize } from "../../lib/format";
import { MCP_SERVER_TONE } from "../../view-models/mcp";

const TRANSPORT_LABEL = { http: "Streamable HTTP", sse: "SSE" } as const;

/** Failed servers are retried only when a run needs them, after a growing wait. */
function retryText(nextRetryAt: string | null, now = Date.now()): string {
  const wait = nextRetryAt ? Date.parse(nextRetryAt) - now : 0;
  return wait > 1_000 ? `Retried when a run needs it, after ${formatRelativeTime(nextRetryAt, now).replace(/^in /, "")}.` : "Retried the next time a run needs it.";
}

function ServerCard({ server, agents, onReconnect, busy }: { server: McpServerSummary; agents: readonly AgentCardSummary[]; onReconnect: () => void; busy: boolean }) {
  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id;
  const canConnect = server.enabled && server.status !== "misconfigured";
  const missing = server.usedBy.flatMap((use) => use.missing.map((name) => `${agentName(use.agentId)} asks for "${name}"`));
  const transport = server.activeTransport ? TRANSPORT_LABEL[server.activeTransport] : server.transport === "auto" ? "Streamable HTTP or SSE" : TRANSPORT_LABEL[server.transport];
  return (
    <Card className="flex flex-col gap-3 px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-md font-semibold text-fg">{server.title}</h3>
          {server.description && <p className="mt-0.5 text-sm text-fg-2">{server.description}</p>}
        </div>
        <StatusBadge tone={MCP_SERVER_TONE[server.status]} />
      </div>

      <KeyValues
        items={[
          ["Address", <span className="font-mono text-[13px]">{server.host ?? "Unknown"}</span>],
          ["Transport", transport],
          ["Used by", server.usedBy.length ? server.usedBy.map((use) => agentName(use.agentId)).join(", ") : "No agents yet"],
          ...(server.lastConnectedAt
            ? [[server.status === "connected" ? "Connected" : "Last connected", <RelativeTime ts={server.lastConnectedAt} />] as [string, ReactNode]]
            : []),
        ]}
      />

      {server.detail && <p className="text-sm text-fg-2">{asSentence(server.detail)}</p>}
      {server.status === "failed" && server.lastError && (
        <p className="rounded-md bg-sunken px-3 py-2 text-sm text-fg-2">
          <span className="text-danger">Last error:</span> {asSentence(server.lastError)}
          <span className="text-fg-3"> {retryText(server.nextRetryAt)}</span>
        </p>
      )}
      {missing.length > 0 && <p className="text-sm text-attention">Not offered by this server: {missing.join("; ")}.</p>}
      {server.guardWarnings.map((warning) => (
        <p key={warning} className="text-sm text-attention">
          {asSentence(warning)}
        </p>
      ))}

      {(server.tools.length > 0 || server.skippedTools.length > 0) && (
        <Disclosure summary={`Tools (${server.tools.length})${server.skippedTools.length ? `, ${server.skippedTools.length} skipped` : ""}`}>
          <ul className="flex flex-col gap-2 pt-2">
            {server.tools.map((tool) => (
              <li key={tool.name} className="text-sm">
                <span className="font-mono text-[13px] text-fg">{tool.name}</span>
                <p className="mt-0.5 text-fg-2">{tool.description.replace(/^\[[^\]]*\]\s*/, "")}</p>
              </li>
            ))}
            {server.skippedTools.map((tool) => (
              <li key={tool.name} className="text-sm">
                <span className="font-mono text-[13px] text-fg-3 line-through">{tool.name}</span>
                <p className="mt-0.5 text-attention">Skipped: {tool.reason}</p>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}

      {canConnect && (
        <div>
          <Button size="sm" icon={<IconRetry size={14} aria-hidden="true" />} onClick={onReconnect} disabled={busy}>
            {busy ? "Connecting" : server.status === "connected" ? "Refresh tools" : "Connect now"}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** MCP tool servers: status, tools and which agents use them. Analytax only connects; it never starts servers. */
export function ToolServersPanel({ initial, agents }: { initial: McpStatus; agents: readonly AgentCardSummary[] }) {
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => setStatus(initial), [initial]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      setStatus(await fetchMcpStatus());
    } catch (error) {
      notify("Could not load tool server status", errorMessage(error));
    } finally {
      setRefreshing(false);
    }
  };

  const reconnect = async (id: string) => {
    setBusy((current) => new Set(current).add(id));
    try {
      const summary = await reconnectMcp(id);
      setStatus((current) => ({ ...current, servers: current.servers.map((server) => (server.id === id ? summary : server)) }));
      notify(summary.status === "connected" ? `${summary.title} connected` : `${summary.title} is still unreachable`, summary.status === "connected" ? pluralize(summary.tools.length, "tool") : (summary.lastError ?? undefined));
    } catch (error) {
      notify("Could not reach the orchestrator", errorMessage(error));
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <Section
      title="Tool servers"
      description="MCP servers that give agents extra tools. Analytax connects to them but never starts or restarts them; configure them in config/mcp.yaml."
      actions={
        <Button size="sm" variant="ghost" icon={<IconRetry size={14} aria-hidden="true" />} onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? "Refreshing" : "Refresh"}
        </Button>
      }
    >
      {!status.enabled && (
        <Callout family="neutral" title="Tool servers are off" className="mb-4">
          {status.disabledReason ?? "MCP is turned off."} Agents run with their built-in tools only.
        </Callout>
      )}
      {status.servers.length === 0 ? (
        <p className="text-sm text-fg-2">No servers configured. Add one to config/mcp.yaml and list its tools in an agent card.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {status.servers.map((server) => (
            <ServerCard key={server.id} server={server} agents={agents} busy={busy.has(server.id)} onReconnect={() => void reconnect(server.id)} />
          ))}
        </div>
      )}
    </Section>
  );
}
