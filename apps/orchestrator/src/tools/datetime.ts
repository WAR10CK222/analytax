import { tool } from "@langchain/core/tools";
import { z } from "zod";

export function describeNow(timeZone: string, now = new Date()): string {
  let zone = timeZone || "UTC";
  let formatted: string;
  try {
    formatted = new Intl.DateTimeFormat("en-US", { timeZone: zone, dateStyle: "full", timeStyle: "long" }).format(now);
  } catch {
    zone = "UTC";
    formatted = new Intl.DateTimeFormat("en-US", { timeZone: zone, dateStyle: "full", timeStyle: "long" }).format(now);
  }
  return JSON.stringify({ iso: now.toISOString(), timeZone: zone, local: formatted, unixSeconds: Math.floor(now.getTime() / 1000) });
}

export function createDatetimeTool() {
  return tool(async ({ timeZone }) => describeNow(timeZone), {
    name: "current_datetime",
    description: "Get the current date and time. Use it for anything relative to today (recency, ages, deadlines).",
    schema: z.object({ timeZone: z.string().describe("IANA time zone such as 'UTC' or 'Europe/Berlin'; use 'UTC' if unknown") }),
  });
}
