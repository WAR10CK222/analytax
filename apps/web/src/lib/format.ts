import type { Usage } from "@analytax/contracts";

/** Placeholder for missing values. Callers pass a context-specific `fallback` where "None" reads wrong. */
export const NONE = "None";

const isNumber = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** 842, 4.2k, 38k, 1.24M */
export function formatTokens(value: number | null | undefined, fallback = NONE): string {
  if (!isNumber(value)) return fallback;
  const abs = Math.abs(value);
  if (abs < 1_000) return Math.round(value).toString();
  if (abs < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (abs < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(abs < 10_000_000 ? 2 : 1)}M`;
}

/** $0.00, $0.0042, $0.137, $12.40 */
export function formatCost(usd: number | null | undefined, fallback = NONE): string {
  if (!isNumber(usd)) return fallback;
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** 850 ms, 4.2 s, 42 s, 3m 05s, 1h 02m */
export function formatDuration(ms: number | null | undefined, fallback = NONE): string {
  if (!isNumber(ms) || ms < 0) return fallback;
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}m ${String(restSeconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** just now, 12s ago, 5m ago, in 2m */
export function formatRelativeTime(ts: string | null | undefined, now: number = Date.now(), fallback = "Never"): string {
  if (!ts) return fallback;
  const time = Date.parse(ts);
  if (Number.isNaN(time)) return fallback;
  const diffSeconds = Math.round((now - time) / 1_000);
  const abs = Math.abs(diffSeconds);
  if (abs < 5) return "just now";
  const unit =
    abs < 60
      ? `${abs}s`
      : abs < 3_600
        ? `${Math.floor(abs / 60)}m`
        : abs < 86_400
          ? `${Math.floor(abs / 3_600)}h`
          : `${Math.floor(abs / 86_400)}d`;
  return diffSeconds < 0 ? `in ${unit}` : `${unit} ago`;
}

/** 14:03:27 in the viewer's locale (24h). */
export function formatClock(ts: string | null | undefined, fallback = NONE): string {
  if (!ts) return fallback;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function formatDateTime(ts: string | null | undefined, fallback = NONE): string {
  if (!ts) return fallback;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium", hour12: false });
}

/** Evaluator scores are 0..1. */
export function formatScore(score: number | null | undefined, fallback = NONE): string {
  return isNumber(score) ? score.toFixed(2) : fallback;
}

export function formatPercent(ratio: number | null | undefined, digits = 0, fallback = NONE): string {
  return isNumber(ratio) ? `${(ratio * 100).toFixed(digits)}%` : fallback;
}

export function formatCount(value: number | null | undefined, fallback = NONE): string {
  return isNumber(value) ? value.toLocaleString() : fallback;
}

/** Milliseconds between an ISO timestamp and `to` (ISO or epoch ms, default now). */
export function elapsedMs(from: string | null | undefined, to: string | number | null = Date.now()): number | null {
  if (!from) return null;
  const start = Date.parse(from);
  const end = typeof to === "number" ? to : to ? Date.parse(to) : Date.now();
  return Number.isNaN(start) || Number.isNaN(end) ? null : Math.max(0, end - start);
}

export const usageTokens = (usage: Usage | null | undefined): number =>
  usage ? usage.inputTokens + usage.outputTokens : 0;

export function shortId(id: string | null | undefined, keep = 8, fallback = NONE): string {
  if (!id) return fallback;
  return id.length > keep + 1 ? `${id.slice(0, keep)}…` : id;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
}

export const pluralize = (count: number, noun: string, plural = `${noun}s`): string =>
  `${count} ${count === 1 ? noun : plural}`;

/** Server-provided fragments ("missing environment variable X") shown as a sentence. */
export function asSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

/** Error-like values from the SDKs, fetch and zod to a readable message. */
export function errorMessage(error: unknown): string {
  if (error == null) return "Unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
