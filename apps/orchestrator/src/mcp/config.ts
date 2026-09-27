import ipaddr from "ipaddr.js";
import { z } from "zod";

/** Server ids are slugs without underscores, so `mcp__<id>__<tool>` always splits unambiguously. */
export const MCP_SERVER_ID = /^[a-z][a-z0-9-]{0,23}$/;

const Positive = z.number().int().positive();

export const McpDefaults = z.strictObject({
  connectTimeoutMs: Positive.default(5_000),
  timeoutMs: Positive.default(30_000),
  maxOutputChars: Positive.default(20_000),
  maxConcurrentCalls: Positive.max(32).default(4),
});

export const McpTransport = z.enum(["auto", "http", "sse"]);
export type McpTransport = z.infer<typeof McpTransport>;

/** Checks Analytax runs on a tool argument before the call leaves the process. */
export const McpArgPolicy = z.enum(["read-only-sql"]);
export type McpArgPolicy = z.infer<typeof McpArgPolicy>;

export type McpGuards = Readonly<Record<string, Readonly<Record<string, McpArgPolicy>>>>;

export const McpServerConfig = z.strictObject({
  enabled: z.boolean().default(true),
  title: z.string().min(1).max(60).optional(),
  description: z.string().max(300).optional(),
  /** Supports `${VAR}` and `${VAR:-default}`. */
  url: z.string().min(1),
  /** `auto`: Streamable HTTP, falling back to the legacy SSE transport when the server rejects it. */
  transport: McpTransport.default("auto"),
  /** Values support `${VAR}` interpolation; they are treated as secrets and never leave the connection. */
  headers: z.record(z.string(), z.string()).default({}),
  tools: z
    .strictObject({
      include: z.array(z.string().min(1)).optional(),
      exclude: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
  timeoutMs: Positive.optional(),
  maxOutputChars: Positive.optional(),
  maxConcurrentCalls: Positive.max(32).optional(),
  /** Allow plain http to a non-loopback host. */
  allowInsecure: z.boolean().default(false),
  /**
   * Argument policies, as `{ <tool>: { <argument>: <policy> } }`. Opt-in on purpose: a rule that cannot be read off
   * this file would be magic, and matching on a tool's name gives false assurance the moment a server renames it.
   */
  guards: z.record(z.string().min(1), z.record(z.string().min(1), McpArgPolicy)).default({}),
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;

export const McpConfig = z.strictObject({
  enabled: z.boolean().default(true),
  defaults: McpDefaults.prefault({}),
  servers: z
    .record(z.string().regex(MCP_SERVER_ID, "server ids must be lowercase letters, digits and dashes (max 24), starting with a letter"), McpServerConfig)
    .default({}),
});
export type McpConfig = z.infer<typeof McpConfig>;

export type ResolvedServer = {
  id: string;
  title: string;
  description: string | null;
  url: URL;
  host: string;
  transport: McpTransport;
  headers: Record<string, string>;
  include: readonly string[] | null;
  exclude: readonly string[];
  guards: McpGuards;
  connectTimeoutMs: number;
  timeoutMs: number;
  maxOutputChars: number;
  maxConcurrentCalls: number;
  /** Every value that must never appear in logs, status or telemetry (interpolated values and header values). */
  secrets: readonly string[];
};

export type ServerResolution =
  | { ok: true; server: ResolvedServer }
  | { ok: false; id: string; title: string; description: string | null; host: string | null; detail: string };

/** Header names Analytax controls itself; overriding them would break the protocol or smuggle requests. */
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "mcp-session-id", "mcp-protocol-version", "last-event-id"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

type Env = Readonly<Record<string, string | undefined>>;

/** Replaces `${VAR}` / `${VAR:-default}`. An unset or empty variable without a default is reported, not substituted. */
export function interpolate(value: string, env: Env): { value: string; missing: string[]; substituted: string[] } {
  const missing: string[] = [];
  const substituted: string[] = [];
  const result = value.replace(PLACEHOLDER, (_match, name: string, fallback: string | undefined) => {
    const fromEnv = env[name];
    const resolved = fromEnv !== undefined && fromEnv !== "" ? fromEnv : fallback;
    if (resolved === undefined) {
      missing.push(name);
      return "";
    }
    if (resolved !== "") substituted.push(resolved);
    return resolved;
  });
  return { value: result, missing, substituted };
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return ipaddr.isValid(host) && ipaddr.process(host).range() === "loopback";
}

/** Host of the raw (uninterpolated) URL, for display when resolution fails. */
function displayHost(rawUrl: string): string | null {
  try {
    return new URL(rawUrl.replace(PLACEHOLDER, "x")).host || null;
  } catch {
    return null;
  }
}

/**
 * Turns one configured server into connection settings, or a "misconfigured" reason. Never throws, so one bad entry
 * cannot take the orchestrator down; problems show up in the status panel and `pnpm validate:config`.
 */
export function resolveServer(id: string, entry: McpServerConfig, defaults: z.infer<typeof McpDefaults>, env: Env): ServerResolution {
  const title = entry.title ?? id;
  const description = entry.description ?? null;
  const fail = (detail: string): ServerResolution => ({ ok: false, id, title, description, host: displayHost(entry.url), detail });

  const url = interpolate(entry.url, env);
  const missing = new Set(url.missing);
  const secrets = new Set(url.substituted);
  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(entry.headers)) {
    if (!HEADER_NAME.test(name)) return fail(`header name "${name}" is not a valid HTTP header name`);
    if (RESERVED_HEADERS.has(name.toLowerCase())) return fail(`header "${name}" is managed by Analytax and cannot be set`);
    const value = interpolate(raw, env);
    for (const name of value.missing) missing.add(name);
    for (const part of value.substituted) secrets.add(part);
    if (value.value) secrets.add(value.value);
    headers[name] = value.value;
  }
  if (missing.size > 0) return fail(`missing environment variable${missing.size === 1 ? "" : "s"} ${[...missing].join(", ")}`);

  let parsed: URL;
  try {
    parsed = new URL(url.value);
  } catch {
    return fail("url is not a valid absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return fail("url must use http or https");
  if (parsed.username || parsed.password) return fail("url must not contain credentials; use headers instead");
  if (parsed.protocol === "http:" && !entry.allowInsecure && !isLoopbackHost(parsed.hostname)) {
    return fail("plain http is only allowed for localhost; use https or set allowInsecure: true");
  }
  // Query strings and paths can carry tokens, so they count as secrets for redaction too.
  if (parsed.search) secrets.add(parsed.search.slice(1));

  return {
    ok: true,
    server: {
      id,
      title,
      description,
      url: parsed,
      host: parsed.host,
      transport: entry.transport,
      headers,
      include: entry.tools.include ?? null,
      exclude: entry.tools.exclude,
      guards: entry.guards,
      connectTimeoutMs: defaults.connectTimeoutMs,
      timeoutMs: entry.timeoutMs ?? defaults.timeoutMs,
      maxOutputChars: entry.maxOutputChars ?? defaults.maxOutputChars,
      maxConcurrentCalls: entry.maxConcurrentCalls ?? defaults.maxConcurrentCalls,
      secrets: [...secrets].filter((secret) => secret.length >= 3),
    },
  };
}
