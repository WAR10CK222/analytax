/**
 * A small local MCP server (Streamable HTTP) for trying MCP tools without an external service. Analytax never starts
 * it: run it yourself, then enable `local-example` in config/mcp.yaml.
 * Usage: pnpm mcp:example            (listens on http://127.0.0.1:3920/mcp; override with MCP_EXAMPLE_PORT)
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PORT = Number(process.env.MCP_EXAMPLE_PORT ?? 3920);

function buildServer(): McpServer {
  const server = new McpServer({ name: "analytax-example", version: "0.1.0" });
  server.registerTool(
    "echo",
    { description: "Returns the given text unchanged. Useful to check that MCP tools work.", inputSchema: { text: z.string().describe("Text to return") } },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  server.registerTool(
    "current_time",
    {
      description: "Current date and time on this machine, optionally in an IANA time zone such as Europe/Berlin.",
      inputSchema: { timeZone: z.string().optional().describe("IANA time zone; defaults to the machine's zone") },
    },
    async ({ timeZone }) => {
      try {
        const text = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "long", timeZone }).format(new Date());
        return { content: [{ type: "text", text }] };
      } catch {
        return { isError: true, content: [{ type: "text", text: `Unknown time zone "${timeZone}".` }] };
      }
    },
  );
  return server;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

const sessions = new Map<string, StreamableHTTPServerTransport>();

const http = createServer((req, res) => {
  void (async () => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/mcp") return void res.writeHead(404).end();
    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (req.method === "POST") {
      const body = await readJson(req);
      if (existing) return existing.handleRequest(req, res, body);
      if (typeof sessionId === "string") return void res.writeHead(404).end();
      if (!isInitializeRequest(body)) return void res.writeHead(400).end();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          console.log(`session ${id.slice(0, 8)} opened (${sessions.size} active)`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await buildServer().connect(transport);
      return transport.handleRequest(req, res, body);
    }
    if (existing) return existing.handleRequest(req, res);
    res.writeHead(typeof sessionId === "string" ? 404 : 405).end();
  })().catch((error: unknown) => {
    console.error(error);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

http.listen(PORT, "127.0.0.1", () => {
  console.log(`Example MCP server on http://127.0.0.1:${PORT}/mcp (tools: echo, current_time). Ctrl+C to stop.`);
});
