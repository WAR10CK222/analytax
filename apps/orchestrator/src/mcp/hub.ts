import type { McpServerStatus, McpServerSummary, McpStatus, RunToolServer } from "@analytax/contracts";
import { ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentCard } from "../agents/registry.js";
import { shortHash, stableStringify } from "../util/hash.js";
import { logger } from "../util/logger.js";
import { resolveServer, type McpConfig, type ResolvedServer, type ServerResolution } from "./config.js";
import { McpConnection, httpStatusOf } from "./connection.js";
import { checkGuards, guardMessage, guardWarnings } from "./guards.js";
import { exposedName } from "./names.js";
import { registerMcpOrigin } from "./origins.js";
import { redact } from "./redact.js";
import { matchesRef, referencedServers, serverAllows, splitToolRefs } from "./refs.js";
import { toGeminiSchema } from "./schema.js";
import { createMcpTool, formatToolOutput, toolDescription } from "./tool.js";

const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;

type ExposedTool = { raw: string; exposed: string; description: string; fingerprint: string; tool: StructuredToolInterface };

type Entry = {
  id: string;
  title: string;
  description: string | null;
  host: string | null;
  transport: "auto" | "http" | "sse";
  enabled: boolean;
  resolution: ServerResolution;
  status: McpServerStatus;
  connection: McpConnection | null;
  connecting: Promise<void> | null;
  tools: Map<string, ExposedTool>;
  skipped: { name: string; reason: string }[];
  guardWarnings: string[];
  toolsStale: boolean;
  lastError: string | null;
  lastConnectedAt: string | null;
  failures: number;
  nextRetryAt: number | null;
  active: number;
  waiters: (() => void)[];
};

export type ToolsForCard = {
  tools: StructuredToolInterface[];
  /** Servers the card references that could not be used, with a short reason. */
  unavailable: { id: string; title: string; reason: string }[];
  /** Changes whenever the exposed tool set changes (names, descriptions or schemas). */
  fingerprint: string;
};

export type McpHubOptions = {
  env: Readonly<Record<string, string | undefined>>;
  /** ANALYTAX_MCP_ENABLED=false */
  killSwitch?: boolean;
  /** ANALYTAX_OFFLINE_MODELS=true */
  offline?: boolean;
  now?: () => number;
};

const DISABLED_DETAIL = "Turned off in config/mcp.yaml.";

/**
 * Owns every MCP connection. Built synchronously (config only, no network); connections open on first use and stay
 * open while they work. After a failure the server is retried only when something needs it again, with exponential
 * backoff: no timers, no polling, and no process management. Servers are the user's responsibility.
 */
export class McpHub {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  readonly enabled: boolean;
  readonly disabledReason: string | null;

  private constructor(config: McpConfig | null, options: McpHubOptions) {
    this.now = options.now ?? Date.now;
    this.disabledReason = !config
      ? "No config/mcp.yaml."
      : options.offline
        ? "Off in offline demo mode."
        : options.killSwitch
          ? "Turned off by ANALYTAX_MCP_ENABLED=false."
          : !config.enabled
            ? "Turned off in config/mcp.yaml."
            : null;
    this.enabled = this.disabledReason === null;
    for (const [id, server] of Object.entries(config?.servers ?? {})) {
      const resolution = resolveServer(id, server, config!.defaults, options.env);
      if (resolution.ok) registerMcpOrigin(resolution.server.url);
      this.entries.set(id, {
        id,
        title: server.title ?? id,
        description: server.description ?? null,
        host: resolution.ok ? resolution.server.host : resolution.host,
        transport: server.transport,
        enabled: server.enabled,
        resolution,
        status: !server.enabled ? "disabled" : resolution.ok ? "idle" : "misconfigured",
        connection: null,
        connecting: null,
        tools: new Map(),
        skipped: [],
        guardWarnings: [],
        toolsStale: false,
        lastError: null,
        lastConnectedAt: null,
        failures: 0,
        nextRetryAt: null,
        active: 0,
        waiters: [],
      });
    }
  }

  static create(config: McpConfig | null, options: McpHubOptions): McpHub {
    return new McpHub(config, options);
  }

  /** Every configured server id, including disabled ones (agent cards may reference them). */
  serverIds(): ReadonlySet<string> {
    return new Set(this.entries.keys());
  }

  /** Servers usable right now: MCP on, server enabled, config resolved. */
  private usable(entry: Entry): entry is Entry & { resolution: { ok: true; server: ResolvedServer } } {
    return this.enabled && entry.enabled && entry.resolution.ok;
  }

  private unusableReason(entry: Entry): string {
    if (!this.enabled) return this.disabledReason ?? "MCP is off.";
    if (!entry.enabled) return DISABLED_DETAIL;
    return entry.resolution.ok ? "" : entry.resolution.detail;
  }

  /** Starts connecting (in the background) to the given servers, or every usable one. Never throws. */
  warmUp(ids?: Iterable<string>): void {
    for (const id of ids ?? this.entries.keys()) void this.ensure(id, { waitMs: 0 });
  }

  /**
   * Makes sure a server is connected with a fresh tool list, waiting up to `waitMs` for an attempt in flight. During
   * backoff it returns immediately without touching the network. Never throws.
   */
  async ensure(id: string, options: { waitMs: number }): Promise<McpServerStatus> {
    const entry = this.entries.get(id);
    if (!entry) return "disabled";
    if (!this.usable(entry)) return entry.status;
    if (entry.status === "connected" && !entry.toolsStale) return entry.status;
    if (!entry.connecting) {
      if (entry.status === "failed" && entry.nextRetryAt !== null && this.now() < entry.nextRetryAt) return entry.status;
      entry.connecting = (entry.status === "connected" && entry.connection?.connected ? this.refreshTools(entry) : this.connect(entry)).finally(() => {
        entry.connecting = null;
      });
    }
    if (options.waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([entry.connecting, new Promise<void>((resolve) => (timer = setTimeout(resolve, options.waitMs)))]).finally(() => clearTimeout(timer));
    }
    return entry.status;
  }

  private async connect(entry: Entry & { resolution: { ok: true; server: ResolvedServer } }): Promise<void> {
    const server = entry.resolution.server;
    entry.status = "connecting";
    const connection = new McpConnection(server);
    connection.onToolsChanged = () => {
      entry.toolsStale = true;
    };
    connection.onClosed = () => {
      if (entry.connection !== connection) return;
      entry.connection = null;
      if (entry.status === "connected") entry.status = "idle";
    };
    try {
      await connection.connect();
      const tools = await connection.listTools();
      await entry.connection?.close();
      entry.connection = connection;
      this.exposeTools(entry, server, tools);
      entry.status = "connected";
      entry.lastError = null;
      entry.failures = 0;
      entry.nextRetryAt = null;
      entry.lastConnectedAt = new Date(this.now()).toISOString();
      logger.info({ server: entry.id, transport: connection.activeTransport, tools: entry.tools.size, skipped: entry.skipped.length }, "mcp server connected");
    } catch (error) {
      await connection.close();
      this.markFailed(entry, error);
    }
  }

  private async refreshTools(entry: Entry & { resolution: { ok: true; server: ResolvedServer } }): Promise<void> {
    try {
      const tools = await entry.connection!.listTools();
      this.exposeTools(entry, entry.resolution.server, tools);
    } catch (error) {
      await entry.connection?.close();
      entry.connection = null;
      this.markFailed(entry, error);
    }
  }

  private markFailed(entry: Entry, error: unknown): void {
    const secrets = entry.resolution.ok ? entry.resolution.server.secrets : [];
    entry.status = "failed";
    entry.failures += 1;
    entry.lastError = describeError(error, secrets);
    entry.nextRetryAt = this.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (entry.failures - 1));
    logger.warn({ server: entry.id, error: entry.lastError, retryInMs: entry.nextRetryAt - this.now() }, "mcp server unavailable");
  }

  /** Builds wrapper tools, reusing unchanged ones so cached agents keep working across reconnects. */
  private exposeTools(entry: Entry, server: ResolvedServer, tools: readonly Tool[]): void {
    const previous = entry.tools;
    const next = new Map<string, ExposedTool>();
    const skipped: { name: string; reason: string }[] = [];
    const taken = new Set<string>();
    // Every tool the server offers, with its argument names: guards are checked against this, before any filtering.
    const offered = new Map<string, ReadonlySet<string>>(
      tools.map((raw) => {
        const properties = (raw.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
        return [raw.name, new Set(Object.keys(properties ?? {}))];
      }),
    );
    for (const raw of tools) {
      if (!serverAllows(server.include, server.exclude, raw.name)) continue;
      const converted = toGeminiSchema(raw.inputSchema);
      if (!converted.ok) {
        skipped.push({ name: raw.name, reason: converted.reason });
        continue;
      }
      const description = toolDescription(server.title, raw.description);
      const fingerprint = shortHash(stableStringify({ name: raw.name, description, schema: converted.schema }));
      const reused = previous.get(raw.name);
      if (reused && reused.fingerprint === fingerprint) {
        taken.add(reused.exposed);
        next.set(raw.name, reused);
        continue;
      }
      const exposed = exposedName(server.id, raw.name, taken);
      taken.add(exposed);
      const rawName = raw.name;
      next.set(raw.name, {
        raw: rawName,
        exposed,
        description,
        fingerprint,
        tool: createMcpTool({ name: exposed, description, schema: converted.schema, invoke: (args, signal) => this.call(entry.id, rawName, args, signal) }),
      });
    }
    entry.tools = next;
    entry.skipped = skipped;
    entry.guardWarnings = guardWarnings(server, offered, new Set(next.keys()));
    entry.toolsStale = false;
    for (const warning of entry.guardWarnings) logger.warn({ server: entry.id, warning }, "mcp guard configuration");
  }

  /** Calls one tool. Returns text for the agent; only a dispatch abort (card timeout or Stop) throws. */
  async call(id: string, rawName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const entry = this.entries.get(id);
    if (!entry || !this.usable(entry)) return `Error from ${entry?.title ?? id}: this tool server is not available (${entry ? this.unusableReason(entry) : "unknown server"}).`;
    const server = entry.resolution.server;
    // Argument policies run before the concurrency slot and the connection, so a blocked call never reaches the wire
    // and never affects the server's health. hub.call is the single funnel every tool wrapper goes through.
    const refusal = checkGuards(server, rawName, args);
    if (refusal) {
      logger.warn(
        { server: id, tool: refusal.tool, arg: refusal.arg, policy: refusal.policy, reason: refusal.reason, statement: redact(refusal.value, server.secrets, 200) },
        "mcp tool call blocked by a guard",
      );
      return guardMessage(server.title, refusal);
    }
    const release = await this.acquire(entry, signal);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (entry.status !== "connected" || !entry.connection?.connected) {
          await this.ensure(id, { waitMs: server.connectTimeoutMs * 2 });
          if (entry.status !== "connected" || !entry.connection) {
            return `Error from ${server.title}: the server is unreachable right now (${entry.lastError ?? "not connected"}). Continue without it.`;
          }
        }
        const connection = entry.connection;
        try {
          const result = await connection.callTool(rawName, args, { signal, timeoutMs: server.timeoutMs });
          return formatToolOutput({ serverId: server.id, serverTitle: server.title, tool: rawName, result, maxChars: server.maxOutputChars });
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
            const seconds = (server.timeoutMs / 1000).toFixed(server.timeoutMs < 10_000 ? 1 : 0);
            return `Error from ${server.title}: timed out after ${seconds}s. The result is unknown; do not assume the action ran.`;
          }
          if (error instanceof McpError) return `Error from ${server.title}: ${redact(error.message, server.secrets, 1_000)}`;
          // A 404 on a request that carried a session id means the server forgot the session and never ran the
          // request, so one reconnect and retry is safe. Anything else may have run: report it, do not retry.
          const expired = httpStatusOf(error) === 404 && connection.hasSession;
          await connection.close();
          if (entry.connection === connection) entry.connection = null;
          if (expired && attempt === 0) {
            entry.status = "idle";
            continue;
          }
          this.markFailed(entry, error);
          return `Error from ${server.title}: the connection failed during the call (${entry.lastError}). The result is unknown.`;
        }
      }
      return `Error from ${server.title}: the session could not be restored.`;
    } finally {
      release();
    }
  }

  /** Per-server concurrency limit, so parallel agents cannot flood one server. */
  private async acquire(entry: Entry, signal?: AbortSignal): Promise<() => void> {
    const limit = entry.resolution.ok ? entry.resolution.server.maxConcurrentCalls : 1;
    while (entry.active >= limit) {
      if (signal?.aborted) throw signal.reason;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          entry.waiters = entry.waiters.filter((waiter) => waiter !== wake);
          reject(signal?.reason);
        };
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        entry.waiters.push(wake);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    entry.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.active -= 1;
      entry.waiters.shift()?.();
    };
  }

  /** The MCP tools one agent card gets for one dispatch, honoring the run's switches. */
  async toolsFor(card: AgentCard, off: ReadonlySet<string>, options: { waitMs: number }): Promise<ToolsForCard> {
    const { mcp } = splitToolRefs(card.tools);
    const tools: StructuredToolInterface[] = [];
    const unavailable: ToolsForCard["unavailable"] = [];
    const fingerprintParts: string[] = [];
    const servers = [...new Set(mcp.map((ref) => ref.server))];
    for (const id of servers) {
      if (off.has(id)) continue;
      const entry = this.entries.get(id);
      if (!entry) continue;
      if (!this.usable(entry)) {
        unavailable.push({ id, title: entry.title, reason: this.unusableReason(entry) });
        continue;
      }
      await this.ensure(id, options);
      if (entry.status !== "connected") {
        unavailable.push({ id, title: entry.title, reason: entry.lastError ?? "not connected" });
        continue;
      }
      const refs = mcp.filter((ref) => ref.server === id);
      for (const exposed of entry.tools.values()) {
        if (!refs.some((ref) => matchesRef(ref, exposed.raw))) continue;
        tools.push(exposed.tool);
        fingerprintParts.push(`${exposed.exposed}:${exposed.fingerprint}`);
      }
    }
    return { tools, unavailable, fingerprint: fingerprintParts.length ? shortHash(fingerprintParts.sort().join("|"), 12) : "none" };
  }

  /** How every server the cards reference looks for a new run. Waits up to `waitMs` in total, in parallel. */
  async runSnapshot(cards: readonly AgentCard[], off: ReadonlySet<string>, waitMs: number): Promise<RunToolServer[]> {
    const referenced = referencedServers(cards).filter((id) => this.entries.has(id));
    await Promise.all(referenced.filter((id) => !off.has(id)).map((id) => this.ensure(id, { waitMs })));
    return referenced.map((id): RunToolServer => {
      const entry = this.entries.get(id)!;
      if (off.has(id)) return { id, title: entry.title, status: "off", toolCount: 0, tools: [], detail: "Turned off for this run." };
      if (!this.enabled || !entry.enabled) return { id, title: entry.title, status: "disabled", toolCount: 0, tools: [], detail: this.unusableReason(entry) };
      if (!entry.resolution.ok) return { id, title: entry.title, status: "misconfigured", toolCount: 0, tools: [], detail: entry.resolution.detail };
      if (entry.status !== "connected") return { id, title: entry.title, status: "unavailable", toolCount: 0, tools: [], detail: entry.lastError ?? "Still connecting." };
      const names = [...entry.tools.values()].map((tool) => tool.raw);
      return { id, title: entry.title, status: "connected", toolCount: names.length, tools: names, detail: null };
    });
  }

  private summary(entry: Entry, cards: readonly AgentCard[]): McpServerSummary {
    const usedBy = cards.flatMap((card) => {
      const refs = splitToolRefs(card.tools).mcp.filter((ref) => ref.server === entry.id);
      if (refs.length === 0) return [];
      const known = entry.status === "connected";
      const missing = known ? refs.filter((ref) => ref.tool !== "*" && !entry.tools.has(ref.tool)).map((ref) => ref.tool) : [];
      return [{ agentId: card.id, refs: refs.map((ref) => ref.tool), missing }];
    });
    const detail = !this.enabled ? this.disabledReason : !entry.enabled ? DISABLED_DETAIL : entry.resolution.ok ? null : entry.resolution.detail;
    return {
      id: entry.id,
      title: entry.title,
      description: entry.description,
      host: entry.host,
      transport: entry.transport,
      activeTransport: entry.connection?.activeTransport ?? null,
      enabled: entry.enabled,
      status: entry.status,
      detail,
      lastError: entry.lastError,
      lastConnectedAt: entry.lastConnectedAt,
      nextRetryAt: entry.status === "failed" && entry.nextRetryAt ? new Date(entry.nextRetryAt).toISOString() : null,
      tools: [...entry.tools.values()].map((tool) => ({ name: tool.raw, exposedName: tool.exposed, description: tool.description })),
      skippedTools: entry.skipped,
      guardWarnings: entry.guardWarnings,
      usedBy,
    };
  }

  status(cards: readonly AgentCard[]): McpStatus {
    return { enabled: this.enabled, disabledReason: this.disabledReason, servers: [...this.entries.values()].map((entry) => this.summary(entry, cards)) };
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Connects now, skipping any backoff. Joins an attempt already in flight. */
  async reconnect(id: string, cards: readonly AgentCard[]): Promise<McpServerSummary | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (this.usable(entry) && !entry.connecting) {
      entry.nextRetryAt = null;
      if (entry.status === "failed") entry.status = "idle";
      if (entry.status === "connected") entry.toolsStale = true;
    }
    await this.ensure(id, { waitMs: (entry.resolution.ok ? entry.resolution.server.connectTimeoutMs : 5_000) * 3 });
    return this.summary(entry, cards);
  }

  /** For scripts and tests. The Agent Server process never needs it: servers expire idle sessions themselves. */
  async close(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => entry.connection?.close()));
    for (const entry of this.entries.values()) {
      entry.connection = null;
      if (entry.status === "connected") entry.status = "idle";
    }
  }
}

function describeError(error: unknown, secrets: readonly string[]): string {
  const status = httpStatusOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
  const prefix = status === 401 || status === 403 ? "Not authorized: " : "";
  return redact(`${prefix}${message}${cause}`, secrets);
}
