import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseHistory, removeRun, upsertRun, RUN_HISTORY_LIMIT } from "../../src/lib/run-history";
import { parsePreference, resolveTheme } from "../../src/lib/theme";
import { parseRoute, resolveScreen, routeSearch } from "../../src/lib/url-state";

describe("url state", () => {
  it("parses the run, tab and task, defaulting to the overview", () => {
    expect(parseRoute("?thread=abc&tab=plan&task=t3")).toEqual({ view: null, thread: "abc", tab: "plan", task: "t3" });
    expect(parseRoute("?thread=abc&tab=bogus")).toMatchObject({ tab: "overview" });
    expect(parseRoute("?view=agents")).toMatchObject({ view: "agents", thread: null });
  });

  it("keeps unknown params and omits defaults", () => {
    expect(routeSearch("?thread=abc&utm=x", { tab: "overview", task: "t1" })).toBe("?thread=abc&utm=x&task=t1");
    expect(routeSearch("?thread=abc&task=t1", { thread: null, task: null })).toBe("");
  });

  it("picks the screen from the URL and the session", () => {
    expect(resolveScreen(parseRoute(""), { threadId: null, starting: false })).toBe("home");
    expect(resolveScreen(parseRoute(""), { threadId: null, starting: true })).toBe("run");
    expect(resolveScreen(parseRoute("?view=agents&thread=x"), { threadId: "x", starting: false })).toBe("agents");
  });
});

describe("run history", () => {
  const now = "2026-09-22T10:00:00.000Z";

  it("adds new runs to the top and caps the list", () => {
    let list = upsertRun([], { threadId: "a", query: "first" }, now);
    for (let index = 0; index < RUN_HISTORY_LIMIT + 5; index += 1) list = upsertRun(list, { threadId: `x${index}`, query: "q" }, now);
    expect(list).toHaveLength(RUN_HISTORY_LIMIT);
    expect(list[0]?.threadId).toBe(`x${RUN_HISTORY_LIMIT + 4}`);
  });

  it("returns the same array when nothing changed (no needless writes)", () => {
    const list = upsertRun([], { threadId: "a", query: "first", status: "running" }, now);
    expect(upsertRun(list, { threadId: "a", status: "running" }, "2026-09-22T11:00:00.000Z")).toBe(list);
  });

  it("orders by activity: a status change moves a run up, reopening a finished run does not", () => {
    const later = "2026-09-22T11:00:00.000Z";
    const list = upsertRun(upsertRun([], { threadId: "a", query: "a" }, now), { threadId: "b", query: "b" }, now);
    const updated = upsertRun(list, { threadId: "a", status: "completed" }, later);
    expect(updated.map((entry) => entry.threadId)).toEqual(["a", "b"]);
    expect(updated[0]?.status).toBe("completed");
    const reopened = upsertRun(updated, { threadId: "b", status: "running" }, "2026-09-22T12:00:00.000Z");
    const settled = upsertRun(reopened, { threadId: "b", status: "completed", activityAt: "2026-09-22T10:30:00.000Z" }, "2026-09-22T12:00:01.000Z");
    expect(settled.map((entry) => entry.threadId)).toEqual(["a", "b"]);
    expect(settled[1]?.updatedAt).toBe("2026-09-22T10:30:00.000Z");
    expect(removeRun(settled, "a").map((entry) => entry.threadId)).toEqual(["b"]);
  });

  it("drops malformed stored data instead of crashing", () => {
    expect(parseHistory("not json")).toEqual([]);
    expect(parseHistory(JSON.stringify([{ threadId: "ok", query: null, createdAt: now, updatedAt: now, status: "completed" }, { nope: true }]))).toHaveLength(1);
  });
});

describe("theme", () => {
  it("defaults to system and resolves against the OS", () => {
    expect(parsePreference(null)).toBe("system");
    expect(parsePreference("sepia")).toBe("system");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });
});

/** Copy rules from the design system: no em/en dashes and no all-caps label styling anywhere in the UI source. */
describe("copy audit", () => {
  const srcDir = path.resolve(import.meta.dirname, "../../src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".tsx")) files.push(full);
    }
  };
  walk(srcDir);

  it.each(files.map((file) => [path.relative(srcDir, file), file]))("%s has no em/en dashes or uppercase labels", (_name, file) => {
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/\buppercase\b/);
  });
});
