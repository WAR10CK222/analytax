import { describe, expect, it } from "vitest";
import { cascadeFailures, type CascadeOptions } from "../../src/planning/cascade.js";
import { NOW, ledger } from "../helpers.js";

const options = (overrides: Partial<CascadeOptions> = {}): CascadeOptions => ({
  now: NOW,
  replanAvailable: true,
  heldTaskIds: new Set(),
  upstreamReplanned: new Set(),
  ...overrides,
});

describe("cascadeFailures", () => {
  it("drops a failed dependency for best_effort dependents and leaves a note", () => {
    const tasks = ledger([
      { id: "t1", status: "failed", statusReason: "no sources" },
      { id: "t2", deps: ["t1"], policy: "best_effort" },
    ]);
    const result = cascadeFailures(tasks, options());
    expect(result.tasks.t2?.dependsOn).toEqual([]);
    expect(result.tasks.t2?.notes[0]).toContain("t1");
    expect(result.dropped).toEqual([{ taskId: "t2", dependency: "t1" }]);
  });

  it("cancels non-critical dependents transitively", () => {
    const tasks = ledger([{ id: "t1", status: "failed" }, { id: "t2", deps: ["t1"] }, { id: "t3", deps: ["t2"] }]);
    const result = cascadeFailures(tasks, options());
    expect(result.tasks.t2).toMatchObject({ status: "canceled", statusReason: "upstream_failed:t1" });
    expect(result.tasks.t3).toMatchObject({ status: "canceled", statusReason: "upstream_failed:t2" });
  });

  it("asks the replanner (once) instead of canceling the critical path", () => {
    const tasks = ledger([{ id: "t1", status: "failed" }, { id: "t2", deps: ["t1"] }, { id: "t3", deps: ["t2"], critical: true }]);
    const result = cascadeFailures(tasks, options());
    expect(result.replanFor).toEqual([{ failedTaskId: "t1", dependentIds: ["t2"] }]);
    expect(result.tasks.t2?.status).toBe("submitted");
  });

  it("cancels the critical path when a replan for that failure already happened", () => {
    const tasks = ledger([{ id: "t1", status: "failed" }, { id: "t2", deps: ["t1"], critical: true }]);
    const result = cascadeFailures(tasks, options({ upstreamReplanned: new Set(["t1"]) }));
    expect(result.tasks.t2?.status).toBe("canceled");
  });

  it("leaves dependents of held failures untouched until their request is handled", () => {
    const tasks = ledger([{ id: "t1", status: "failed" }, { id: "t2", deps: ["t1"] }]);
    const result = cascadeFailures(tasks, options({ heldTaskIds: new Set(["t1"]) }));
    expect(result.changed).toEqual({});
  });

  it("falls back to the original when a revision fails", () => {
    const tasks = ledger([
      { id: "t1", status: "completed", agentId: "writer", capability: "writing" },
      { id: "t2", status: "failed", revisionOf: "t1", deps: ["t1"], agentId: "writer", capability: "writing" },
      { id: "t3", deps: ["t2"], critical: true },
    ]);
    const result = cascadeFailures(tasks, options());
    expect(result.tasks.t3?.dependsOn).toEqual(["t1"]);
    expect(result.rewired).toEqual([{ taskId: "t3", from: "t2", to: "t1" }]);
    expect(result.replanFor).toEqual([]);
  });

  it("never cancels the main path because optional follow-up work failed", () => {
    const tasks = ledger([
      { id: "t1", status: "failed", origin: { kind: "proposal", parentTaskId: "t0", depth: 1 } },
      { id: "t2", deps: ["t1"], critical: true },
    ]);
    const result = cascadeFailures(tasks, options());
    expect(result.tasks.t2).toMatchObject({ status: "submitted", dependsOn: [] });
  });
});
