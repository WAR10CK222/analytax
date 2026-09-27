import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCard } from "../../src/agents/registry.js";
import { McpConfig } from "../../src/mcp/config.js";
import { McpHub } from "../../src/mcp/hub.js";
import { startTestMcpServer, type TestMcpServer } from "../harness/mcp-server.js";
import { testAgents } from "../helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function serve(options?: Parameters<typeof startTestMcpServer>[0]): Promise<TestMcpServer> {
  const server = await startTestMcpServer(options);
  cleanups.push(() => server.close());
  return server;
}

function hubFor(servers: Record<string, Record<string, unknown>>, options: { env?: Record<string, string>; now?: () => number } = {}): McpHub {
  const hub = McpHub.create(McpConfig.parse({ defaults: { connectTimeoutMs: 2_000 }, servers }), { env: options.env ?? {}, now: options.now });
  cleanups.push(() => hub.close());
  return hub;
}

/** A URL nobody listens on. */
async function closedUrl(): Promise<string> {
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  await new Promise<void>((resolve) => http.close(() => resolve()));
  return `http://127.0.0.1:${port}/mcp`;
}

const card = (tools: string[]): AgentCard => ({ ...testAgents().require("researcher"), tools });

describe("McpHub", () => {
  it("connects over Streamable HTTP, lists tools and calls them", async () => {
    const server = await serve();
    const hub = hubFor({ example: { url: server.url } });
    expect(await hub.ensure("example", { waitMs: 3_000 })).toBe("connected");
    const status = hub.status([]).servers[0]!;
    expect(status).toMatchObject({ status: "connected", activeTransport: "http", host: new URL(server.url).host });
    expect(status.tools.map((tool) => tool.exposedName)).toEqual(expect.arrayContaining(["mcp__example__echo", "mcp__example__slow"]));
    const output = await hub.call("example", "echo", { text: "hello" });
    expect(output).toContain('trust="untrusted"');
    expect(output).toContain("hello");
    expect(await hub.call("example", "fail", {})).toBe("Error from example: boom");
  });

  it("falls back to the SSE transport for old servers", async () => {
    const server = await serve({ transport: "sse" });
    const hub = hubFor({ legacy: { url: server.url } });
    expect(await hub.ensure("legacy", { waitMs: 3_000 })).toBe("connected");
    expect(hub.status([]).servers[0]?.activeTransport).toBe("sse");
    expect(await hub.call("legacy", "echo", { text: "old" })).toContain("old");
  });

  it("sends configured headers, and a wrong token fails without leaking it", async () => {
    const server = await serve({ requireHeader: { name: "Authorization", value: "Bearer right-token" } });
    const good = hubFor({ secure: { url: server.url, headers: { Authorization: "Bearer ${TOKEN}" } } }, { env: { TOKEN: "right-token" } });
    expect(await good.ensure("secure", { waitMs: 3_000 })).toBe("connected");

    const bad = hubFor({ secure: { url: server.url, headers: { Authorization: "Bearer ${TOKEN}" } } }, { env: { TOKEN: "wrong-token" } });
    expect(await bad.ensure("secure", { waitMs: 3_000 })).toBe("failed");
    const status = bad.status([]).servers[0]!;
    expect(status.lastError).toBeTruthy();
    expect(JSON.stringify(bad.status([]))).not.toContain("wrong-token");
  });

  it("backs off after a failure and reconnect() skips the backoff", async () => {
    let now = 1_000_000;
    const hub = hubFor({ down: { url: await closedUrl() } }, { now: () => now });
    expect(await hub.ensure("down", { waitMs: 3_000 })).toBe("failed");
    const firstRetry = hub.status([]).servers[0]!.nextRetryAt;
    expect(firstRetry).toBe(new Date(now + 5_000).toISOString());

    // Inside the backoff window nothing is attempted.
    expect(await hub.ensure("down", { waitMs: 3_000 })).toBe("failed");
    expect(hub.status([]).servers[0]!.nextRetryAt).toBe(firstRetry);

    // After it, the next attempt doubles the wait.
    now += 6_000;
    await hub.ensure("down", { waitMs: 3_000 });
    expect(hub.status([]).servers[0]!.nextRetryAt).toBe(new Date(now + 10_000).toISOString());

    // A manual reconnect ignores the window.
    const summary = await hub.reconnect("down", []);
    expect(summary?.status).toBe("failed");
    expect(summary?.nextRetryAt).toBe(new Date(now + 20_000).toISOString());
  });

  it("re-establishes an expired session once and retries the call", async () => {
    const server = await serve();
    const hub = hubFor({ example: { url: server.url } });
    expect(await hub.call("example", "echo", { text: "one" })).toContain("one");
    server.forgetSessions();
    expect(await hub.call("example", "echo", { text: "two" })).toContain("two");
    expect(server.initializeCount()).toBe(2);
  });

  it("times out slow calls and stays connected", async () => {
    const server = await serve();
    const hub = hubFor({ example: { url: server.url, timeoutMs: 200 } });
    expect(await hub.call("example", "slow", { ms: 2_000 })).toContain("timed out after 0.2s");
    expect(await hub.call("example", "echo", { text: "still here" })).toContain("still here");
    expect(hub.status([]).servers[0]?.status).toBe("connected");
  });

  it("limits concurrent calls per server", async () => {
    const server = await serve();
    const hub = hubFor({ example: { url: server.url, maxConcurrentCalls: 1 } });
    await Promise.all([hub.call("example", "slow", { ms: 150 }), hub.call("example", "slow", { ms: 150 }), hub.call("example", "slow", { ms: 150 })]);
    expect(server.maxInFlight()).toBe(1);
  });

  it("gives each card only its allowed tools, honoring per-run switches", async () => {
    const server = await serve();
    const hub = hubFor({ example: { url: server.url, tools: { exclude: ["fail"] } }, off: { enabled: false, url: "https://off.example.com/mcp" } });
    const all = await hub.toolsFor(card(["calculator", "mcp:example/*", "mcp:off/*"]), new Set(), { waitMs: 3_000 });
    expect(all.tools.map((tool) => tool.name).sort()).toEqual(["mcp__example__echo", "mcp__example__slow"]);
    expect(all.unavailable).toEqual([{ id: "off", title: "off", reason: "Turned off in config/mcp.yaml." }]);

    const one = await hub.toolsFor(card(["mcp:example/echo"]), new Set(), { waitMs: 3_000 });
    expect(one.tools.map((tool) => tool.name)).toEqual(["mcp__example__echo"]);
    expect(one.fingerprint).not.toBe(all.fingerprint);

    const switchedOff = await hub.toolsFor(card(["mcp:example/*"]), new Set(["example"]), { waitMs: 3_000 });
    expect(switchedOff.tools).toEqual([]);
    expect(switchedOff.unavailable).toEqual([]);

    // Reconnecting keeps the same wrapper tools, so cached agents stay valid.
    await hub.reconnect("example", []);
    const again = await hub.toolsFor(card(["mcp:example/*", "mcp:off/*"]), new Set(), { waitMs: 3_000 });
    expect(again.fingerprint).toBe(all.fingerprint);
    expect(again.tools[0]).toBe(all.tools[0]);
  });

  it("summarizes servers for a run and for the status panel", async () => {
    const server = await serve();
    const hub = hubFor({
      example: { url: server.url },
      down: { url: await closedUrl() },
      nokey: { url: "https://k.example.com/mcp", headers: { Authorization: "Bearer ${MISSING_KEY}" } },
      off: { enabled: false, url: "https://off.example.com/mcp" },
    });
    const cards = [card(["mcp:example/echo", "mcp:example/nope", "mcp:down/*", "mcp:nokey/*", "mcp:off/*"])];
    const snapshot = await hub.runSnapshot(cards, new Set(["off"]), 3_000);
    expect(snapshot.map((entry) => [entry.id, entry.status])).toEqual([
      ["down", "unavailable"],
      ["example", "connected"],
      ["nokey", "misconfigured"],
      ["off", "off"],
    ]);
    const example = hub.status(cards).servers.find((entry) => entry.id === "example")!;
    expect(example.usedBy).toEqual([{ agentId: "researcher", refs: ["echo", "nope"], missing: ["nope"] }]);
  });

  it("stays off entirely when MCP is disabled", async () => {
    const server = await serve();
    const hub = McpHub.create(McpConfig.parse({ servers: { example: { url: server.url } } }), { env: {}, killSwitch: true });
    expect(await hub.ensure("example", { waitMs: 1_000 })).toBe("idle");
    expect(server.initializeCount()).toBe(0);
    expect(hub.status([])).toMatchObject({ enabled: false, disabledReason: "Turned off by ANALYTAX_MCP_ENABLED=false." });
    expect(await hub.call("example", "echo", { text: "x" })).toContain("not available");
  });
});

describe("McpHub argument guards", () => {
  /** A server whose execute_sql records every statement it is asked to run. */
  async function sqlServer(): Promise<{ url: string; seen: string[] }> {
    const seen: string[] = [];
    const server = await serve({
      register: (mcp) =>
        mcp.registerTool("execute_sql", { description: "Runs SQL.", inputSchema: { sql: z.string() } }, async ({ sql }) => {
          seen.push(sql);
          return { content: [{ type: "text", text: "ran" }] };
        }),
    });
    return { url: server.url, seen };
  }

  const guarded = (url: string) =>
    hubFor({ db: { url, title: "Local postgres", guards: { execute_sql: { sql: "read-only-sql" } } } });

  it("refuses a write without sending it, and leaves the server healthy", async () => {
    const { url, seen } = await sqlServer();
    const hub = guarded(url);
    expect(await hub.ensure("db", { waitMs: 3_000 })).toBe("connected");

    const blocked = await hub.call("db", "execute_sql", { sql: "DELETE FROM meeting" });
    expect(blocked).toMatch(/^Error from Local postgres: blocked by the read-only-sql guard on execute_sql/);
    expect(seen).toEqual([]);

    const allowed = await hub.call("db", "execute_sql", { sql: "SELECT count(*) FROM meeting" });
    expect(allowed).toContain("ran");
    expect(seen).toEqual(["SELECT count(*) FROM meeting"]);

    const status = hub.status([]).servers[0]!;
    expect(status.status).toBe("connected");
    expect(status.nextRetryAt).toBeNull();
    expect(status.guardWarnings).toEqual([]);
  });

  it("blocks a second statement smuggled after a select", async () => {
    const { url, seen } = await sqlServer();
    const hub = guarded(url);
    expect(await hub.call("db", "execute_sql", { sql: "SELECT 1; DROP TABLE meeting" })).toContain("more than one statement");
    expect(seen).toEqual([]);
  });

  it("warns when a guard names a tool or argument the server does not offer", async () => {
    const { url } = await sqlServer();
    const hub = hubFor({ db: { url, guards: { execute_sql: { query: "read-only-sql" }, run_query: { sql: "read-only-sql" } } } });
    await hub.ensure("db", { waitMs: 3_000 });
    const warnings = hub.status([]).servers[0]!.guardWarnings;
    expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining('guard on "run_query": this server does not offer that tool'), expect.stringContaining('has no "query" argument')]));
  });
});
