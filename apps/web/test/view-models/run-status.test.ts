import { describe, expect, it } from "vitest";
import { deriveProgress } from "../../src/view-models/progress";
import { deriveRunStatus } from "../../src/view-models/run-status";

const base = { finalStatus: null, pendingInterrupts: 0, isLoading: false, threadStatus: "busy" as const, starting: false };

describe("deriveRunStatus", () => {
  it("reports a paused run as needing input, even when the ledger phase is executing", () => {
    expect(deriveRunStatus({ ...base, phase: "planning", pendingInterrupts: 1 })).toBe("needs_input");
  });

  it("treats an active phase with nothing running on the server as stopped", () => {
    expect(deriveRunStatus({ ...base, phase: "executing", threadStatus: "idle" })).toBe("stopped");
    expect(deriveRunStatus({ ...base, phase: "executing", threadStatus: "error" })).toBe("stopped");
  });

  it("keeps running while the SDK streams or the server says busy", () => {
    expect(deriveRunStatus({ ...base, phase: "executing", isLoading: true, threadStatus: "idle" })).toBe("running");
    expect(deriveRunStatus({ ...base, phase: "executing" })).toBe("running");
    expect(deriveRunStatus({ ...base, phase: "executing", threadStatus: null })).toBe("running");
  });

  it("distinguishes complete, partial and failed", () => {
    expect(deriveRunStatus({ ...base, phase: "completed", finalStatus: "complete" })).toBe("completed");
    expect(deriveRunStatus({ ...base, phase: "completed", finalStatus: "partial" })).toBe("partial");
    expect(deriveRunStatus({ ...base, phase: "failed" })).toBe("failed");
  });

  it("shows starting before the first event", () => {
    expect(deriveRunStatus({ ...base, phase: "idle", starting: true })).toBe("starting");
    expect(deriveRunStatus({ ...base, phase: "idle" })).toBe("idle");
  });
});

describe("deriveProgress", () => {
  const input = { hasIntent: true, tasks: { done: 0, total: 0 }, wave: 0, hasFinal: false, interruptKind: null };

  it("puts a plan-approval pause on the Plan step as waiting", () => {
    const { steps } = deriveProgress({ ...input, phase: "awaiting_human", status: "needs_input", interruptKind: "approve_plan", tasks: { done: 0, total: 5 } });
    expect(steps.map((step) => step.state)).toEqual(["done", "waiting", "upcoming", "upcoming"]);
    expect(steps[1]?.detail).toBe("Waiting for you");
  });

  it("puts a clarify pause on Understand", () => {
    const { steps } = deriveProgress({ ...input, phase: "awaiting_human", status: "needs_input", interruptKind: "clarify" });
    expect(steps[0]?.state).toBe("waiting");
  });

  it("shows task progress on Execute", () => {
    const { steps, executeRatio } = deriveProgress({ ...input, phase: "executing", status: "running", tasks: { done: 2, total: 5 }, wave: 2 });
    expect(steps[2]).toMatchObject({ state: "current", detail: "2 of 5 tasks" });
    expect(executeRatio).toBeCloseTo(0.4);
  });

  it("marks everything done when the run finished", () => {
    const { steps } = deriveProgress({ ...input, phase: "completed", status: "completed", tasks: { done: 5, total: 5 }, wave: 4, hasFinal: true });
    expect(steps.every((step) => step.state === "done")).toBe(true);
  });

  it("does not mark Execute done when a partial answer left tasks unfinished", () => {
    const { steps } = deriveProgress({ ...input, phase: "completed", status: "partial", tasks: { done: 0, total: 5 }, wave: 3, hasFinal: true });
    expect(steps.map((step) => step.state)).toEqual(["done", "done", "partial", "done"]);
    expect(steps[2]?.detail).toBe("0 of 5 tasks");
  });

  it("marks the step where a stopped run halted", () => {
    const { steps } = deriveProgress({ ...input, phase: "executing", status: "stopped", tasks: { done: 3, total: 5 }, wave: 3 });
    expect(steps.map((step) => step.state)).toEqual(["done", "done", "stopped", "upcoming"]);
    expect(steps[2]?.detail).toBe("3 of 5 tasks, stopped here");
  });
});
