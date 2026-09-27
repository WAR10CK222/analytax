import type { PlanOp, Task } from "@analytax/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyPlanOps } from "../../src/planning/apply-plan-ops.js";
import { findCycle } from "../../src/planning/dag.js";
import { readyTasks } from "../../src/planning/readiness.js";
import { addOp, applyContext, ledger, spec, testConfig } from "../helpers.js";

const human = { kind: "human", taskId: null } as const;

function seed(): Record<string, Task> {
  const result = applyPlanOps(
    {},
    [
      addOp("r1", spec({ title: "Research vendor A" })),
      addOp("r2", spec({ title: "Research vendor B" })),
      addOp("r3", spec({ title: "Compare vendors", capability: "analysis", agentId: "analyst", dependsOn: ["r1", "r2"] })),
    ],
    applyContext({}, { planVersion: 0 }),
    "atomic",
  );
  expect(result.ok).toBe(true);
  return result.tasks;
}

describe("applyPlanOps", () => {
  it("builds a DAG from refs atomically and schedules by readiness", () => {
    const tasks = seed();
    expect(Object.keys(tasks)).toEqual(["t1", "t2", "t3"]);
    expect(tasks.t3?.dependsOn).toEqual(["t1", "t2"]);
    expect(readyTasks(tasks).map((task) => task.id)).toEqual(["t1", "t2"]);
  });

  it("atomic mode rejects the whole batch when any op is invalid", () => {
    const result = applyPlanOps(
      {},
      [addOp("r1", spec({ title: "Valid" })), addOp("r2", spec({ title: "Invalid", agentId: "nobody" }))],
      applyContext({}),
      "atomic",
    );
    expect(result.ok).toBe(false);
    expect(result.tasks).toEqual({});
    expect(result.errors.join(" ")).toContain("unknown agent 'nobody'");
  });

  it("per-op mode keeps valid ops and reports invalid ones", () => {
    const tasks = seed();
    const result = applyPlanOps(
      tasks,
      [addOp("x", spec({ title: "Extra research" })), addOp("y", spec({ title: "Bad capability", capability: "writing" }))],
      applyContext(tasks),
      "per-op",
    );
    expect(result.applied).toHaveLength(1);
    expect(result.rejected[0]?.errors.join(" ")).toContain("does not offer capability 'writing'");
    expect(result.tasks.t4?.title).toBe("Extra research");
    expect(result.planVersion).toBe(2);
  });

  it("rejects exact duplicates of existing tasks", () => {
    const tasks = seed();
    const result = applyPlanOps(tasks, [addOp("dup", spec({ title: "Research vendor A" }))], applyContext(tasks), "per-op");
    expect(result.rejected[0]?.duplicateOf).toBe("t1");
  });

  it("rejects operations that would create a cycle", () => {
    const tasks = seed();
    const op: PlanOp = { op: "add_dependency", taskId: "t1", dependsOn: "t3", reason: "", source: human };
    const result = applyPlanOps(tasks, [op], applyContext(tasks), "per-op");
    expect(result.rejected[0]?.errors.join(" ")).toContain("cycle");
    expect(result.tasks.t1?.dependsOn).toEqual([]);
  });

  it("inserts a prerequisite before a pending task (add_task + add_dependency)", () => {
    const tasks = seed();
    const result = applyPlanOps(
      tasks,
      [
        addOp("p", spec({ title: "Gather pricing data" }), { kind: "policy", taskId: "t3" }),
        { op: "add_dependency", taskId: "t3", dependsOn: "p", reason: "prerequisite", source: { kind: "policy", taskId: "t3" } },
      ],
      applyContext(tasks),
      "per-op",
    );
    expect(result.tasks.t3?.dependsOn).toEqual(["t1", "t2", "t4"]);
    expect(result.tasks.t4?.origin).toMatchObject({ kind: "proposal", parentTaskId: "t3", depth: 1 });
    expect(result.diff.rewired).toEqual([{ taskId: "t3", dependsOn: ["t1", "t2", "t4"] }]);
  });

  it("split_task rewires dependents to the sinks and supersedes the parent", () => {
    const tasks = seed();
    const op: PlanOp = {
      op: "split_task",
      taskId: "t1",
      reason: "too big",
      source: human,
      sinks: [],
      subtasks: [
        { ...spec({ title: "Vendor A pricing" }), ref: "s1" },
        { ...spec({ title: "Vendor A performance", dependsOn: ["s1"] }), ref: "s2" },
      ],
    };
    const result = applyPlanOps(tasks, [op], applyContext(tasks), "atomic");
    expect(result.ok).toBe(true);
    expect(result.tasks.t1).toMatchObject({ status: "canceled", statusReason: "superseded", supersededBy: ["t4", "t5"] });
    expect(result.tasks.t3?.dependsOn).toEqual(["t5", "t2"]);
    expect(result.tasks.t5?.dependsOn).toEqual(["t4"]);
    expect(result.spentFingerprints).toContain(tasks.t1?.fingerprint);
  });

  it("revise_task redoes completed work and rewires pending dependents", () => {
    const tasks = ledger([
      { id: "t1", title: "Write draft", agentId: "writer", capability: "writing", status: "completed", critical: true },
      { id: "t2", title: "Review draft", agentId: "critic", capability: "review", deps: ["t1"], status: "completed" },
      { id: "t3", title: "Publish summary", agentId: "writer", capability: "summarization", deps: ["t1"] },
      { id: "t4", title: "Translate", agentId: "writer", capability: "editing", deps: ["t1"], status: "completed" },
    ]);
    const op: PlanOp = { op: "revise_task", taskId: "t1", instructions: "Apply the review", waitFor: ["t2"], reason: "", source: { kind: "proposal", taskId: "t2" } };
    const result = applyPlanOps(tasks, [op], applyContext(tasks), "per-op");
    expect(result.tasks.t5).toMatchObject({ revisionOf: "t1", dependsOn: ["t2", "t1"], critical: false });
    expect(result.tasks.t3?.dependsOn).toEqual(["t5"]);
    expect(result.tasks.t2?.staleInputs).toBe(false);
    expect(result.tasks.t4?.staleInputs).toBe(true);
    expect(result.tasks.t1?.revisions).toBe(1);
  });

  it("retry_task revives a failed task and dependents canceled because of it", () => {
    const tasks = ledger([
      { id: "t1", status: "failed", statusReason: "ladder exhausted" },
      { id: "t2", deps: ["t1"], status: "canceled", statusReason: "upstream_failed:t1" },
      { id: "t3", deps: ["t2"], status: "canceled", statusReason: "upstream_failed:t2" },
    ]);
    const op: PlanOp = { op: "retry_task", taskId: "t1", resetAttempts: true, instructions: "Try a narrower query", agentId: null, reason: "", source: human };
    const result = applyPlanOps(tasks, [op], applyContext(tasks), "per-op");
    expect(result.tasks.t1).toMatchObject({ status: "submitted", instructions: "Try a narrower query", attempt: 0 });
    expect(result.tasks.t2?.status).toBe("submitted");
    expect(result.tasks.t3?.status).toBe("submitted");
  });

  it("enforces the total task cap", () => {
    const { maxTotalTasks } = testConfig().orchestrator.guards;
    const tasks = ledger(Array.from({ length: maxTotalTasks }, (_, i) => ({ id: `t${i + 1}`, title: `Task number ${i + 1}` })));
    const result = applyPlanOps(tasks, [addOp("one-more", spec({ title: "One too many" }))], applyContext(tasks), "per-op");
    expect(result.rejected[0]?.errors.join(" ")).toContain("task limit");
  });

  it("enforces spawn depth for proposal-origin tasks", () => {
    const { maxSpawnDepth } = testConfig().orchestrator.guards;
    const tasks = ledger([{ id: "t1", origin: { kind: "proposal", depth: maxSpawnDepth } }]);
    const result = applyPlanOps(tasks, [addOp("deep", spec({ title: "Deeper" }), { kind: "proposal", taskId: "t1" })], applyContext(tasks), "per-op");
    expect(result.rejected[0]?.errors.join(" ")).toContain("spawn depth");
  });

  it("property: random op sequences never create cycles or dangling dependencies", () => {
    const ids = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
    const idArb = fc.constantFrom(...ids);
    const opArb: fc.Arbitrary<PlanOp> = fc.oneof(
      fc
        .record({ n: fc.integer({ min: 0, max: 10_000 }), deps: fc.subarray(ids, { maxLength: 3 }) })
        .map(({ n, deps }) => addOp(`r${n}`, spec({ title: `Generated ${n}`, dependsOn: deps }))),
      fc.record({ taskId: idArb, dependsOn: idArb }).map(({ taskId, dependsOn }): PlanOp => ({ op: "add_dependency", taskId, dependsOn, reason: "", source: human })),
      fc.record({ taskId: idArb, dependsOn: idArb }).map(({ taskId, dependsOn }): PlanOp => ({ op: "remove_dependency", taskId, dependsOn, reason: "", source: human })),
      idArb.map((taskId): PlanOp => ({ op: "cancel_task", taskId, cascade: "drop_dependency", reason: "", source: human })),
      fc.record({ taskId: idArb, n: fc.integer({ min: 0, max: 10_000 }) }).map(
        ({ taskId, n }): PlanOp => ({
          op: "split_task",
          taskId,
          reason: "",
          source: human,
          sinks: [],
          subtasks: [
            { ...spec({ title: `Split ${n} part 1` }), ref: `s${n}a` },
            { ...spec({ title: `Split ${n} part 2`, dependsOn: [`s${n}a`] }), ref: `s${n}b` },
          ],
        }),
      ),
    );

    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        let tasks = seed();
        for (const op of ops) tasks = applyPlanOps(tasks, [op], applyContext(tasks), "per-op").tasks;
        for (const task of Object.values(tasks)) {
          for (const dependency of task.dependsOn) if (!tasks[dependency]) return false;
        }
        return findCycle(tasks) === null;
      }),
      { numRuns: 150 },
    );
  });
});
