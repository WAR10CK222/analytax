import { createHash } from "node:crypto";

export const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

export const shortHash = (text: string, length = 16): string => sha1(text).slice(0, length);

/** JSON.stringify with sorted object keys, so equal values hash identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}
