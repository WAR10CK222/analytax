import { describe, expect, it } from "vitest";
import { activityCounts, liveStepEntries, selectActivity } from "../../src/view-models/activity";
import { narrateAdaptations } from "../../src/view-models/adaptations";
import { describeDiff } from "../../src/view-models/plan";
import { plainThought } from "../../src/view-models/dispatch";
import { overviewGroups, taskCounts } from "../../src/view-models/tasks";
import { costCell, orchestrationCounters, waveBars } from "../../src/view-models/usage";
import { adaptiveRun, ephemeral, fold } from "../fixtures/events";

describe("narrateAdaptations", () => {
  const events = adaptiveRun();
  const title = (id: string) => ({ t1: "Task t1", t2: "Write brief", t3: "Find data" })[id] ?? id;
  const story = narrateAdaptations(events, title);

  it("pairs the prerequisite patch with the block instead of narrating both", () => {
    const kinds = story.map((item) => item.kind);
    expect(kinds).toEqual(["prerequisite", "retry", "guard"]);
    expect(story[0]?.title).toBe('"Task t1" was blocked, so "Find data" was added first');
    expect(story[0]?.diff).toEqual({ added: 1, updated: 0, canceled: 0, rewired: 1 });
  });

  it("strips the boilerplate from retry feedback", () => {
    expect(story[1]?.detail).toBe("Missing required sections: Recommendation");
  });

  it("never uses dash punctuation in generated copy", () => {
    for (const item of story) expect(`${item.title} ${item.detail ?? ""}`).not.toMatch(/[–—]/);
  });
});

describe("activity", () => {
  const { timeline } = fold(adaptiveRun());

  it("filters decisions, tasks and issues", () => {
    const counts = activityCounts(timeline.entries, null, false);
    expect(counts.all).toBeGreaterThan(counts.decisions);
    const decisions = selectActivity(timeline.entries, { filter: "decisions", taskId: null, showAgentSteps: false });
    expect(decisions.every((entry) => /^(plan|replan|human|clarification|proposal|guard)\./.test(entry.type))).toBe(true);
  });

  it("keeps a wave separator only when entries sit under it", () => {
    const rows = selectActivity(timeline.entries, { filter: "all", taskId: null, showAgentSteps: false });
    rows.forEach((entry, index) => {
      if (entry.type === "wave.started") expect(rows[index - 1]?.type).not.toBe("wave.started");
    });
  });

  it("turns live tool calls and thoughts into rows", () => {
    const live = [
      ephemeral("agent.tool.finished", { dispatchId: "t1.a1.w1", tool: "web_search", callId: "c1", ok: true, durationMs: 800, preview: "3 results" }, { taskId: "t1" }),
      ephemeral("agent.thought", { dispatchId: "t1.a1.w1", text: "Compare latency first." }, { taskId: "t1" }),
    ];
    expect(liveStepEntries(live).map((entry) => entry.title)).toEqual(["Used web_search", "Thinking"]);
  });
});

describe("tasks and usage", () => {
  const views = fold(adaptiveRun());

  it("counts work left to do, excluding canceled tasks", () => {
    expect(taskCounts(views.taskBoard)).toMatchObject({ total: 3, done: 0 });
  });

  it("groups tasks for the overview and omits empty groups", () => {
    const groups = overviewGroups(views.taskBoard, undefined, "partial");
    expect(groups.every((group) => group.cards.length > 0)).toBe(true);
    expect(groups.find((group) => group.id === "up_next")?.label).toBe("Not started");
  });

  it("says Not priced instead of $0.00 when tokens were used", () => {
    expect(costCell({ costUsd: 0, inputTokens: 10, outputTokens: 5 })).toEqual({ text: "Not priced", priced: false });
    expect(costCell({ costUsd: 0.25, inputTokens: 10, outputTokens: 5 }).text).toBe("$0.250");
  });

  it("marks waves without progress and scales bars to the longest wave", () => {
    const bars = waveBars([
      { wave: 1, durationMs: 1000, reports: 1, progress: false },
      { wave: 2, durationMs: 4000, reports: 2, progress: true },
    ]);
    expect(bars.map((bar) => [bar.ratio, bar.stalled])).toEqual([
      [0.25, true],
      [1, false],
    ]);
  });

  it("exposes every orchestration counter, including ones the old UI never showed", () => {
    const labels = orchestrationCounters(views.metrics, views.ledger).flatMap((group) => group.items.map((item) => item.label));
    for (const label of ["Requeued after errors", "Suggestions deferred", "Changes rejected by validation", "Questions asked", "Canceled"]) {
      expect(labels).toContain(label);
    }
  });

  it("counts every stalled wave, not just the current streak", () => {
    const metrics = { ...views.metrics, waves: [
      { wave: 1, durationMs: 1000, reports: 1, progress: false },
      { wave: 2, durationMs: 1000, reports: 1, progress: true },
      { wave: 3, durationMs: 1000, reports: 1, progress: false },
    ] };
    const items = orchestrationCounters(metrics, { ...views.ledger, stallCount: 0 }).flatMap((group) => group.items);
    expect(items.find((item) => item.label === "Waves without progress")?.value).toBe(2);
  });

  it("describes plan diffs in plain words", () => {
    expect(describeDiff({ added: ["a", "b"], updated: [], canceled: ["c"], rewired: ["d"] })).toBe("2 added, 1 removed, 1 rewired");
    expect(describeDiff({ added: [], updated: [], canceled: [], rewired: [] })).toBe("No task changes");
  });
});

describe("plainThought", () => {
  it("drops markdown markers from thought previews", () => {
    expect(plainThought("**My Cloud Database Options**\n\nOkay, `ClickHouse` first")).toBe("My Cloud Database Options Okay, ClickHouse first");
    expect(plainThought("## Plan\nstep one")).toBe("Plan step one");
  });
});
