import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type TestMcpServerOptions = {
  /** Which transports the server speaks. "sse" answers Streamable HTTP POSTs with 405, like an old server. */
  transport?: "http" | "sse";
  /** Rejects requests without this header value (401). */
  requireHeader?: { name: string; value: string };
  /** Extra tools; `echo` and `slow` are always registered. */
  register?: (server: McpServer) => void;
};

export type TestMcpServer = {
  url: string;
  /** How many `initialize` requests reached the server (one per session). */
  initializeCount: () => number;
  /** Drops every Streamable HTTP session, so the next request with an old session id gets 404. */
  forgetSessions: () => void;
  /** Tool calls currently running on the server. */
  inFlight: () => number;
  maxInFlight: () => number;
  close: () => Promise<void>;
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/** An in-process MCP server on a random localhost port, for hub integration tests. */
export async function startTestMcpServer(options: TestMcpServerOptions = {}): Promise<TestMcpServer> {
  let initializes = 0;
  let running = 0;
  let peak = 0;
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const sseSessions = new Map<string, SSEServerTransport>();

  const build = (): McpServer => {
    const server = new McpServer({ name: "analytax-test", version: "0.0.0" });
    server.registerTool("echo", { description: "Echoes text back.", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text }] }));
    server.registerTool("slow", { description: "Waits, then answers.", inputSchema: { ms: z.number().int() } }, async ({ ms }) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running -= 1;
      return { content: [{ type: "text", text: `waited ${ms}` }] };
    });
    server.registerTool("fail", { description: "Always fails.", inputSchema: {} }, async () => ({ isError: true, content: [{ type: "text", text: "boom" }] }));
    options.register?.(server);
    return server;
  };

  const authorized = (req: IncomingMessage): boolean => !options.requireHeader || req.headers[options.requireHeader.name.toLowerCase()] === options.requireHeader.value;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!authorized(req)) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (options.transport === "sse") {
      if (req.method === "GET" && url.pathname === "/mcp") {
        const transport = new SSEServerTransport("/messages", res);
        sseSessions.set(transport.sessionId, transport);
        res.on("close", () => sseSessions.delete(transport.sessionId));
        await build().connect(transport);
        return;
      }
      if (req.method === "POST" && url.pathname === "/messages") {
        const transport = sseSessions.get(url.searchParams.get("sessionId") ?? "");
        if (!transport) {
          res.writeHead(404).end();
          return;
        }
        const body = await readJson(req);
        if (isInitializeRequest(body)) initializes += 1;
        await transport.handlePostMessage(req, res, body);
        return;
      }
      res.writeHead(405).end();
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (req.method === "POST") {
      const body = await readJson(req);
      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }
      if (typeof sessionId === "string") {
        res.writeHead(404).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
        return;
      }
      if (!isInitializeRequest(body)) {
        res.writeHead(400).end();
        return;
      }
      initializes += 1;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
      });
      await build().connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }
    res.writeHead(typeof sessionId === "string" ? 404 : 405).end();
  };

  const http: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    initializeCount: () => initializes,
    forgetSessions: () => sessions.clear(),
    inFlight: () => running,
    maxInFlight: () => peak,
    close: async () => {
      for (const transport of sessions.values()) await transport.close().catch(() => undefined);
      for (const transport of sseSessions.values()) await transport.close().catch(() => undefined);
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
