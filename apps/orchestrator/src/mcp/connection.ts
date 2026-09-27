import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedServer } from "./config.js";

const CLIENT = { name: "analytax", version: "0.1.0" };
const MAX_TOOLS = 200;

export type ActiveTransport = "http" | "sse";

/** Status code of a failed HTTP exchange with the server, when the SDK reports one. */
export function httpStatusOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" && code >= 100 && code < 600 ? code : undefined;
}

/** A 4xx from the Streamable HTTP initialize means "old server": the spec says to retry with the SSE transport. */
const shouldFallBackToSse = (error: unknown): boolean => {
  const status = httpStatusOf(error);
  return error instanceof StreamableHTTPError && status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 403;
};

/**
 * One live MCP session with one server. It only talks to servers the user runs; it never starts processes.
 * Headers (which may hold secrets) live only here.
 */
export class McpConnection {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | SSEClientTransport | null = null;
  activeTransport: ActiveTransport | null = null;
  /** Called when the server says its tool list changed, or when the session closes. */
  onToolsChanged: () => void = () => {};
  onClosed: () => void = () => {};

  constructor(private readonly server: ResolvedServer) {}

  get connected(): boolean {
    return this.client !== null;
  }

  /** True when the server issued a Streamable HTTP session id (a 404 then means "session expired"). */
  get hasSession(): boolean {
    return this.transport instanceof StreamableHTTPClientTransport && Boolean(this.transport.sessionId);
  }

  async connect(signal?: AbortSignal): Promise<void> {
    await this.close();
    const order: ActiveTransport[] = this.server.transport === "auto" ? ["http", "sse"] : [this.server.transport];
    let lastError: unknown = new Error("no transport attempted");
    for (const kind of order) {
      const client = new Client(CLIENT);
      const requestInit: RequestInit = { headers: { ...this.server.headers } };
      const transport =
        kind === "http"
          ? new StreamableHTTPClientTransport(this.server.url, {
              requestInit,
              // The optional server-to-client stream reconnects a few times at most; tool calls never depend on it.
              reconnectionOptions: { maxRetries: 2, initialReconnectionDelay: 1_000, maxReconnectionDelay: 10_000, reconnectionDelayGrowFactor: 2 },
            })
          : new SSEClientTransport(this.server.url, { requestInit });
      try {
        await client.connect(transport, { timeout: this.server.connectTimeoutMs, signal });
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => this.onToolsChanged());
        client.onclose = () => {
          if (this.client !== client) return;
          this.client = null;
          this.transport = null;
          this.activeTransport = null;
          this.onClosed();
        };
        this.client = client;
        this.transport = transport;
        this.activeTransport = kind;
        return;
      } catch (error) {
        lastError = error;
        await client.close().catch(() => undefined);
        if (!(kind === "http" && order.length > 1 && shouldFallBackToSse(error))) throw error;
      }
    }
    throw lastError;
  }

  async listTools(): Promise<Tool[]> {
    const client = this.require();
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.server.connectTimeoutMs * 2 });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < MAX_TOOLS);
    return tools.slice(0, MAX_TOOLS);
  }

  async callTool(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs: number }): Promise<CallToolResult> {
    const client = this.require();
    const result = await client.callTool({ name, arguments: args }, undefined, { signal: options.signal, timeout: options.timeoutMs });
    return result as CallToolResult;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.transport = null;
    this.activeTransport = null;
    if (client) {
      client.onclose = undefined;
      await client.close().catch(() => undefined);
    }
  }

  private require(): Client {
    if (!this.client) throw new Error("not connected");
    return this.client;
  }
}
