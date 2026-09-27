import type { Task } from "@analytax/contracts";
import { describe, expect, it } from "vitest";
import { decide, type PolicyInput } from "../../src/control/policy.js";
import { makeReport, makeTask, outcome, testAgents, testConfig, verdict } from "../helpers.js";

const config = testConfig();

function input(task: Task, overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    task,
    report: makeReport(task),
    card: testAgents().require(task.agentId),
    altAgentId: null,
    guards: config.orchestrator.guards,
    degradedScore: config.orchestrator.evaluation.degradedScore,
    hitl: { clarify: true, approvePlan: false, humanReview: false },
    humanReviewsLeft: 3,
    replansLeft: 3,
    stopRequested: false,
    hasDependents: true,
    errorRepeats: 0,
    outputRepeat: false,
    ...overrides,
  };
}

const writer = (attempt: number, tier: Task["currentTier"] = "standard", extra: Partial<Task> = {}): Task => ({
  ...makeTask({ id: "t1", agentId: "writer", capability: "writing", attempt, tier, status: "working" }),
  ...extra,
});

const rejected = (task: Task) => makeReport(task, { outcome: outcome(), verdict: verdict("revise") });

describe("recovery policy", () => {
  it("accepts work the judge accepted", () => {
    const task = writer(1);
    expect(decide(input(task, { report: makeReport(task, { outcome: outcome(), verdict: verdict("accept") }) })).kind).toBe("accept");
  });

  it("requeues transient errors without spending semantic attempts", () => {
    const task = writer(1);
    const report = makeReport(task, { error: { kind: "model", transient: true, signature: "model:429:", message: "429" } });
    expect(decide(input(task, { report }))).toMatchObject({ kind: "requeue" });
  });

  it("treats exhausted transient errors as a rejection", () => {
    const task = writer(1, "standard", { infraRetries: config.orchestrator.guards.maxInfraRetries });
    const report = makeReport(task, { error: { kind: "model", transient: true, signature: "model:503:", message: "503" } });
    expect(decide(input(task, { report })).kind).toBe("retry");
  });

  it("climbs the ladder: retry → escalate tier → reassign → replan", () => {
    const first = writer(1);
    expect(decide(input(first, { report: rejected(first) })).kind).toBe("retry");

    const second = writer(2);
    expect(decide(input(second, { report: rejected(second) }))).toMatchObject({ kind: "escalate", toTier: "deep" });

    const third = writer(3, "deep");
    expect(decide(input(third, { report: rejected(third), altAgentId: "generalist" }))).toMatchObject({ kind: "reassign", toAgentId: "generalist" });

    const fourth = writer(4, "deep");
    expect(decide(input(fourth, { report: rejected(fourth) }))).toMatchObject({ kind: "replan", trigger: "ladder_exhausted" });
  });

  it("jumps straight to escalation when the output repeats", () => {
    const task = writer(1);
    expect(decide(input(task, { report: rejected(task), outputRepeat: true })).kind).toBe("escalate");
  });

  it("stops the ladder on repeated identical errors", () => {
    const task = writer(1);
    const report = makeReport(task, { error: { kind: "schema", transient: false, signature: "schema:x", message: "bad" } });
    expect(decide(input(task, { report, errorRepeats: 3 }))).toMatchObject({ kind: "replan", guard: "error_loop" });
  });

  it("asks a human when replans are exhausted and HITL is on for critical tasks", () => {
    const task = writer(4, "deep", { critical: true });
    const action = decide(input(task, { report: rejected(task), replansLeft: 0, hitl: { clarify: true, approvePlan: false, humanReview: true } }));
    expect(action).toMatchObject({ kind: "human", request: "task_failed" });
  });

  it("fails with a degraded result when nothing else is possible", () => {
    const task = writer(4, "deep");
    const report = makeReport(task, { outcome: outcome(), verdict: verdict("revise", { score: 0.6 }) });
    expect(decide(input(task, { report, replansLeft: 0, hasDependents: false }))).toMatchObject({ kind: "fail", degraded: true });
  });

  it("inserts a prerequisite when an agent is blocked", () => {
    const task = writer(1);
    const prerequisite = { kind: "prerequisite" as const, title: "Get data", instructions: "Find data", capability: "web_research", rationale: "needed" };
    const report = makeReport(task, { outcome: outcome({ status: "blocked", proposals: [prerequisite] }) });
    expect(decide(input(task, { report }))).toMatchObject({ kind: "block", prerequisite });

    const looping = writer(1, "standard", { blockCount: config.orchestrator.guards.maxBlocks });
    expect(decide(input(looping, { report }))).toMatchObject({ kind: "replan", guard: "block_loop" });
  });

  it("reassigns declined tasks, or rejects them when no one else can do it", () => {
    const task = writer(1);
    const report = makeReport(task, { outcome: outcome({ status: "declined" }) });
    expect(decide(input(task, { report, altAgentId: "generalist" })).kind).toBe("reassign");
    expect(decide(input(task, { report })).kind).toBe("reject");
  });

  it("routes needs_input to a human when enabled, otherwise proceeds on assumptions once", () => {
    const task = writer(1);
    const report = makeReport(task, { outcome: outcome({ status: "needs_input", openQuestions: ["Which region?"] }) });
    expect(decide(input(task, { report, hitl: { clarify: true, approvePlan: false, humanReview: true } }))).toMatchObject({
      kind: "input_required",
      questions: ["Which region?"],
    });
    expect(decide(input(task, { report }))).toMatchObject({ kind: "retry", assume: true });
  });

  it("keeps passing work and fails the rest when the run is stopping", () => {
    const task = writer(1);
    expect(decide(input(task, { stopRequested: true, report: makeReport(task, { outcome: outcome(), verdict: verdict("accept") }) })).kind).toBe("accept");
    expect(decide(input(task, { stopRequested: true, report: rejected(task) })).kind).toBe("fail");
  });
});
