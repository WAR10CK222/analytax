import type { WorkerError, WorkerErrorKind } from "@analytax/contracts";
import { truncate } from "./text.js";

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_PATTERN =
  /RESOURCE_EXHAUSTED|rate.?limit|quota|UNAVAILABLE|overloaded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network|timed? ?out/i;

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const value of [candidate.statusCode, candidate.status, candidate.response?.status]) {
    if (typeof value === "number") return value;
  }
  return null;
}

/** Strips volatile parts (numbers, ids, urls, quotes) so repeated failures share a signature. */
export function normalizeErrorMessage(message: string): string {
  return truncate(
    message
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, "<url>")
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<id>")
      .replace(/\d+(\.\d+)?/g, "<n>")
      .replace(/(["'`]).*?\1/g, "<q>")
      .replace(/\s+/g, " ")
      .trim(),
    120,
    "",
  );
}

export function classifyError(error: unknown, hints: { timedOut?: boolean } = {}): WorkerError {
  const message = errorMessage(error);
  const name = (error as { name?: string } | null)?.name ?? "";
  const status = statusOf(error);
  let kind: WorkerErrorKind = "unknown";
  let transient = false;

  if (hints.timedOut || name === "TimeoutError") {
    kind = "timeout";
    transient = true;
  } else if (name === "AbortError") {
    kind = "aborted";
  } else if (status !== null) {
    kind = "model";
    transient = TRANSIENT_STATUS.has(status);
  } else if (/ToolCallLimit|model call limit|recursion/i.test(`${name} ${message}`)) {
    kind = "limit";
  } else if (/ZodError|StructuredOutput|MalformedOutput|OutputParser|schema|parse/i.test(`${name} ${message}`)) {
    kind = "schema";
  } else if (TRANSIENT_PATTERN.test(message)) {
    kind = "model";
    transient = true;
  } else if (/tool/i.test(name)) {
    kind = "tool";
  }

  return {
    kind,
    transient,
    signature: `${kind}:${status ?? ""}:${normalizeErrorMessage(message)}`,
    message: truncate(message, 600),
  };
}
