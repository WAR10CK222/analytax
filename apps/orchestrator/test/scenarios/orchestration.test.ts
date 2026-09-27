import type { PlanDraftWire, PlanTaskWire } from "@analytax/contracts";
import { describe, expect, it } from "vitest";
import { eventTypes, eventsOf, createTestDeps, startRun } from "../harness/run.js";
import { ScriptedAgentRunner, ScriptedStructuredInvoker, acceptAll, planIntent, rejectWith, wireOutcome } from "../harness/scripted.js";

const task = (overrides: Partial<PlanTaskWire> & { ref: string; title: string }): PlanTaskWire => ({
  instructions: `Do: ${overrides.title}`,
  acceptanceCriteria: ["Covers the requested scope"],
  checks: [],
  capability: "web_research",
  agentId: "researcher",
  complexity: "medium",
  dependsOn: [],
  contextFrom: [],
  critical: true,
  dependencyPolicy: "all",
  ...overrides,
});

const researchPlan: PlanDraftWire = {
  rationale: "Research both vendors in parallel, compare, then write the recommendation.",
  synthesisGuidance: "Lead with the recommendation.",
  tasks: [
    task({ ref: "r1", title: "Research vendor A" }),
    task({ ref: "r2", title: "Research vendor B" }),
    task({ ref: "r3", title: "Compare vendors", capability: "analysis", agentId: "analyst", dependsOn: ["r1", "r2"] }),
    task({ ref: "r4", title: "Write recommendation", capability: "writing", agentId: "writer", dependsOn: ["r3"] }),
  ],
};

const QUERY = "Which vendor should we choose, A or B?";

describe("orchestration scenarios", () => {
  it("fans out independent work in parallel, threads context downstream, and is deterministic", async () => {
    const sequences: string[][] = [];
    for (let run = 0; run < 5; run++) {
      const agents = new ScriptedAgentRunner(
        (ctx) => wireOutcome({ summary: `Summary of ${ctx.title}`, output: `Detailed output for ${ctx.title} with enough content.` }),
        () => Math.floor(Math.random() * 15),
      );
      const deps = createTestDeps({ structured: new ScriptedStructuredInvoker({ planner: () => researchPlan }), agentRunner: agents });
      const handle = await startRun(deps, QUERY, null, `parallel-${run}`);
      const state = await handle.state();

      expect(state.final?.status).toBe("complete");
      const waves = eventsOf(state, "wave.started").map((event) => event.data.dispatchIds.map((id) => id.split(".")[0]));
      expect(waves).toEqual([["t1", "t2"], ["t3"], ["t4"]]);
      const analystPrompt = agents.calls.find((call) => call.agentId === "analyst")?.prompt ?? "";
      expect(analystPrompt).toContain("Summary of Research vendor A");
      expect(analystPrompt).toContain("Summary of Research vendor B");
      expect(handle.custom.some((event) => event.type === "agent.started")).toBe(true);
      sequences.push(eventTypes(state));
    }
    for (const sequence of sequences) expect(sequence).toEqual(sequences[0]);
  });

  it("inserts a prerequisite discovered mid-task and re-runs the blocked task after it", async () => {
    const agents = new ScriptedAgentRunner((ctx) => {
      if (ctx.agentId === "analyst" && ctx.attempt === 1 && !ctx.prompt.includes("Pricing data found")) {
        return wireOutcome({
          status: "blocked",
          summary: "Cannot compare without pricing data.",
          output: "Partial comparison: performance only.",
          proposals: [
            { kind: "prerequisite", title: "Collect pricing for both vendors", instructions: "Find current list pricing for vendor A and vendor B.", capability: "web_research", rationale: "Pricing is required for the comparison" },
          ],
        });
      }
      if (ctx.title === "Collect pricing for both vendors") return wireOutcome({ summary: "Pricing data found" });
      return wireOutcome({ summary: `Summary of ${ctx.title}` });
    });
    const deps = createTestDeps({ structured: new ScriptedStructuredInvoker({ planner: () => researchPlan }), agentRunner: agents });
    const state = await (await startRun(deps, QUERY)).state();

    expect(state.final?.status).toBe("complete");
    expect(state.tasks.t5).toMatchObject({ title: "Collect pricing for both vendors", status: "completed", origin: { kind: "proposal", parentTaskId: "t3" } });
    expect(state.tasks.t3?.dependsOn).toContain("t5");
    const blocked = eventsOf(state, "task.blocked")[0];
    expect(blocked?.data.prerequisiteTaskId).toBe("t5");

    const analystCalls = agents.calls.filter((call) => call.agentId === "analyst");
    expect(analystCalls).toHaveLength(2);
    expect(analystCalls[1]?.attempt).toBe(1); // blocking is not a semantic attempt
    expect(analystCalls[1]?.prompt).toContain("Pricing data found");
    expect(analystCalls[1]?.prompt).toContain("Partial comparison: performance only.");
    const writerIndex = agents.calls.findIndex((call) => call.agentId === "writer");
    const pricingIndex = agents.calls.findIndex((call) => call.title === "Collect pricing for both vendors");
    expect(writerIndex).toBeGreaterThan(pricingIndex);
    expect(state.plan.version).toBeGreaterThan(1);
  });

  it("accepts follow-up proposals once, even when siblings propose the same work", async () => {
    const followUp = { kind: "follow_up" as const, title: "Verify benchmark claims", instructions: "Independently verify the published benchmark numbers for both vendors.", capability: "fact_checking", rationale: "Benchmarks look vendor-sponsored" };
    const agents = new ScriptedAgentRunner((ctx) =>
      ctx.title.startsWith("Research vendor") ? wireOutcome({ summary: `Summary of ${ctx.title}`, proposals: [followUp] }) : wireOutcome({ summary: `Summary of ${ctx.title}` }),
    );
    const deps = createTestDeps({ structured: new ScriptedStructuredInvoker({ planner: () => researchPlan }), agentRunner: agents });
    const state = await (await startRun(deps, QUERY)).state();

    const followUps = Object.values(state.tasks).filter((entry) => entry.title === "Verify benchmark claims");
    expect(followUps).toHaveLength(1);
    expect(eventsOf(state, "proposal.accepted")).toHaveLength(1);
    expect(eventsOf(state, "proposal.dropped")[0]?.data.reason).toContain("duplicate");
    expect(state.tasks.t3?.dependsOn).toContain(followUps[0]!.id);
    const verifyIndex = agents.calls.findIndex((call) => call.title === "Verify benchmark claims");
    const analystIndex = agents.calls.findIndex((call) => call.agentId === "analyst");
    expect(verifyIndex).toBeLessThan(analystIndex);
    expect(state.final?.status).toBe("complete");
  });

  it("climbs the recovery ladder and lets the replanner split a task that keeps failing", async () => {
    const plan: PlanDraftWire = {
      rationale: "Single writing task.",
      synthesisGuidance: "",
      tasks: [task({ ref: "r1", title: "Write the brief", capability: "writing", agentId: "writer" })],
    };
    const structured = new ScriptedStructuredInvoker({
      planner: () => plan,
      judge: (call, index) => (call.user.includes('id="t1"') ? rejectWith("Too vague") : acceptAll(call, index)),
      replanner: () => ({
        diagnosis: "The brief is too broad for one pass; split it.",
        giveUp: false,
        ops: [
          {
            op: "split_task",
            reason: "split into sections",
            taskId: "t1",
            dependsOn: "",
            instructions: "",
            agentId: "",
            waitFor: [],
            tasks: [
              task({ ref: "s1", title: "Write the context section", capability: "writing", agentId: "writer" }),
              task({ ref: "s2", title: "Write the recommendation section", capability: "writing", agentId: "writer", dependsOn: ["s1"] }),
            ],
          },
        ],
      }),
    });
    const agents = new ScriptedAgentRunner((ctx) => wireOutcome({ summary: `Attempt ${ctx.attempt} of ${ctx.title}`, output: `Draft ${ctx.attempt} for ${ctx.title} with some content.` }));
    const deps = createTestDeps({ structured, agentRunner: agents });
    const state = await (await startRun(deps, "Write a brief about vendor choice")).state();

    const t1Tiers = agents.calls.filter((call) => call.taskId === "t1").map((call) => call.tier);
    expect(t1Tiers).toEqual(["standard", "standard", "deep"]);
    expect(eventTypes(state)).toEqual(expect.arrayContaining(["task.retried", "task.escalated", "replan.requested", "replan.completed"]));
    expect(eventsOf(state, "plan.patched").some((event) => event.data.source === "replanner")).toBe(true);
    expect(state.tasks.t1).toMatchObject({ status: "canceled", statusReason: "superseded" });
    expect(state.final?.status).toBe("complete");
  });

  it("stops error loops with guards and synthesizes a partial answer", async () => {
    const plan: PlanDraftWire = {
      rationale: "Research then analysis.",
      synthesisGuidance: "",
      tasks: [
        task({ ref: "r1", title: "Research the market", critical: false }),
        task({ ref: "r2", title: "Research competitors", critical: false }),
      ],
    };
    const structured = new ScriptedStructuredInvoker({
      planner: () => plan,
      replanner: () => ({
        diagnosis: "Retry with a narrower scope.",
        giveUp: false,
        ops: [{ op: "retry_task", reason: "narrower", taskId: "t1", dependsOn: "", instructions: "Narrow the scope to 2025 data", agentId: "", waitFor: [], tasks: [] }],
      }),
    });
    const agents = new ScriptedAgentRunner((ctx) => (ctx.title === "Research the market" ? new Error("upstream parser exploded") : wireOutcome()));
    const deps = createTestDeps({
      structured,
      agentRunner: agents,
      configure: (config) => ({ ...config, orchestrator: { ...config.orchestrator, guards: { ...config.orchestrator.guards, maxReplans: 1 } } }),
    });
    const state = await (await startRun(deps, "Summarize the market")).state();

    expect(state.final?.status).toBe("partial");
    expect(state.final?.gaps.map((gap) => gap.taskId)).toContain("t1");
    expect(state.tasks.t2?.status).toBe("completed");
    expect(agents.calls.filter((call) => call.title === "Research the market").length).toBeLessThanOrEqual(8);
    expect(eventsOf(state, "run.completed")).toHaveLength(1);
  });

  it("pauses for plan approval, applies the reviewer's edit, and resumes without re-planning", async () => {
    const structured = new ScriptedStructuredInvoker({ planner: () => researchPlan });
    const agents = new ScriptedAgentRunner((ctx) => wireOutcome({ summary: `Summary of ${ctx.title}` }));
    const deps = createTestDeps({ structured, agentRunner: agents });
    const handle = await startRun(deps, QUERY, { hitl: { approvePlan: true } }, "approval");

    const [pending] = (await handle.interrupts()) as { kind: string; tasks: { id: string }[] }[];
    expect(pending?.kind).toBe("approve_plan");
    expect(pending?.tasks.map((entry) => entry.id)).toEqual(["t1", "t2", "t3", "t4"]);

    await handle.resume({
      decision: "edit",
      ops: [{ op: "update_task", taskId: "t4", patch: { instructions: "Write a one-paragraph recommendation." }, reason: "shorter", source: { kind: "human" } }],
    });
    const state = await handle.state();
    expect(structured.count("planner")).toBe(1);
    expect(state.tasks.t4?.instructions).toBe("Write a one-paragraph recommendation.");
    expect(eventsOf(state, "plan.approved")[0]?.data.edited).toBe(true);
    expect(state.final?.status).toBe("complete");
    const ids = (state.events as { id: string }[]).map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rescues a critical path whose upstream task could not be done", async () => {
    const plan: PlanDraftWire = {
      rationale: "Research then analysis.",
      synthesisGuidance: "",
      tasks: [task({ ref: "r1", title: "Research internal metrics" }), task({ ref: "r2", title: "Analyze metrics", capability: "analysis", agentId: "analyst", dependsOn: ["r1"] })],
    };
    const structured = new ScriptedStructuredInvoker({
      planner: () => plan,
      replanner: () => ({
        diagnosis: "Internal metrics are unavailable; analyze public benchmarks instead.",
        giveUp: false,
        ops: [
          { op: "remove_dependency", reason: "input unavailable", taskId: "t2", dependsOn: "t1", instructions: "", agentId: "", waitFor: [], tasks: [] },
          { op: "update_task", reason: "use public data", taskId: "t2", dependsOn: "", instructions: "Analyze publicly available benchmarks instead.", agentId: "", waitFor: [], tasks: [] },
        ],
      }),
    });
    const agents = new ScriptedAgentRunner((ctx) =>
      ctx.title === "Research internal metrics" ? wireOutcome({ status: "declined", summary: "No access to internal systems." }) : wireOutcome({ summary: `Summary of ${ctx.title}` }),
    );
    const deps = createTestDeps({ structured, agentRunner: agents });
    const state = await (await startRun(deps, "How do our metrics compare?")).state();

    expect(state.tasks.t1?.status).toBe("rejected");
    expect(eventsOf(state, "replan.requested").some((event) => event.data.trigger === "upstream_failed")).toBe(true);
    expect(state.tasks.t2).toMatchObject({ status: "completed", dependsOn: [], instructions: "Analyze publicly available benchmarks instead." });
    expect(state.final?.status).toBe("partial");
  });

  it("recovers from a crash inside reconcile without duplicating events", async () => {
    let calls = 0;
    const deps = createTestDeps({
      structured: new ScriptedStructuredInvoker({ planner: () => researchPlan }),
      agentRunner: new ScriptedAgentRunner((ctx) => wireOutcome({ summary: `Summary of ${ctx.title}` })),
      resolveHook: () => {
        calls += 1;
        if (calls === 1) throw new Error("simulated crash in reconcile");
      },
    });
    const state = await (await startRun(deps, QUERY, null, "crash")).state();

    expect(state.final?.status).toBe("complete");
    const seqs = (state.events as { seq: number | null }[]).map((event) => event.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });
});
