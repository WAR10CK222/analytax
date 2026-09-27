import { lookup } from "node:dns/promises";
import { tool } from "@langchain/core/tools";
import { convert } from "html-to-text";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import { truncate } from "../util/text.js";

const MAX_BYTES = 2_000_000;
const DEFAULT_MAX_CHARS = 12_000;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

export class FetchBlockedError extends Error {
  override name = "FetchBlockedError";
}

/** SSRF guard: http(s) only, and every resolved address must be public unicast. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchBlockedError(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchBlockedError("Only http(s) URLs are allowed");
  if (url.username || url.password) throw new FetchBlockedError("URLs with credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new FetchBlockedError(`Blocked host: ${host}`);
  }
  const addresses = ipaddr.isValid(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  for (const address of addresses) {
    const range = ipaddr.process(address).range();
    if (range !== "unicast") throw new FetchBlockedError(`Blocked non-public address ${address} (${range})`);
  }
  return url;
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

export async function fetchReadable(rawUrl: string, maxChars = DEFAULT_MAX_CHARS, signal?: AbortSignal): Promise<string> {
  let url = await assertPublicUrl(rawUrl);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    response = await fetch(url, {
      redirect: "manual",
      signal: combined,
      headers: { "user-agent": "AnalytaxResearchBot/0.1 (+https://github.com/)", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
    });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) break;
    url = await assertPublicUrl(new URL(location, url).toString());
    response = null;
  }
  if (!response) throw new Error(`Too many redirects fetching ${rawUrl}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);

  const contentType = response.headers.get("content-type") ?? "";
  const body = await readLimited(response);
  let text: string;
  let title = "";
  if (/html/i.test(contentType) || /^\s*<!doctype html|<html/i.test(body)) {
    title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ?? "";
    text = convert(body, {
      wordwrap: false,
      selectors: [
        { selector: "a", options: { ignoreHref: true } },
        { selector: "img", format: "skip" },
        { selector: "nav", format: "skip" },
        { selector: "footer", format: "skip" },
        { selector: "script", format: "skip" },
        { selector: "style", format: "skip" },
      ],
    });
  } else if (/text|json|xml|markdown/i.test(contentType) || contentType === "") {
    text = body;
  } else {
    throw new Error(`Unsupported content type '${contentType}' at ${url}`);
  }
  const cleaned = text.replace(/\n{3,}/g, "\n\n").trim();
  return `${title ? `Title: ${title}\n` : ""}URL: ${url}\n\n${truncate(cleaned, maxChars)}`;
}

export function createFetchUrlTool() {
  return tool(
    async ({ url, maxChars }, config) => {
      try {
        return await fetchReadable(url, maxChars > 0 ? Math.min(maxChars, 40_000) : DEFAULT_MAX_CHARS, config?.signal);
      } catch (error) {
        return `Could not fetch ${url}: ${(error as Error).message}`;
      }
    },
    {
      name: "fetch_url",
      description:
        "Fetch a public web page or text document and return its readable text. Use it to read primary sources " +
        "found via web_search. Private/internal addresses are blocked.",
      schema: z.object({
        url: z.string().describe("Absolute http(s) URL"),
        maxChars: z.number().int().describe("Maximum characters to return (use 12000 unless you need more; max 40000)"),
      }),
    },
  );
}
