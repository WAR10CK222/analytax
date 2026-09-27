import {
  ApprovePlanResume,
  HumanReviewResume,
  isTerminalStatus,
  toTaskPreview,
  type ApprovePlanInterrupt,
  type ClarifyInterrupt,
  type HumanReviewInterrupt,
  type PlanOp,
  type Task,
} from "@analytax/contracts";
import { Command, interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { DurableEvents, traceRefFromRun } from "../../control/events.js";
import { applyPlanOps, PLAN_REJECTED } from "../../planning/apply-plan-ops.js";
import { sortedTasks } from "../../planning/dag.js";
import { recordDurableEvents } from "../../telemetry/metrics.js";
import type { OrchestratorDeps } from "../deps.js";
import type { State, Update } from "../state.js";

// Interrupt nodes do nothing with side effects before `interrupt()`: on resume the node re-runs from the top.

const eventsFor = (state: State, now: string, planVersion = state.plan.version) =>
  new DurableEvents(
    state.control.eventSeq,
    { runId: state.run.runId, threadId: state.run.threadId, planVersion, trace: traceRefFromRun(state.run) },
    () => now,
  );

function normalizeAnswers(raw: unknown, count: number): string[] {
  if (typeof raw === "string") return count <= 1 ? [raw] : raw.split("\n");
  if (Array.isArray(raw)) return raw.map((answer) => String(answer ?? ""));
  const answers = (raw as { answers?: unknown } | null)?.answers;
  return Array.isArray(answers) ? answers.map((answer) => String(answer ?? "")) : [];
}

export function createClarifyNode(deps: OrchestratorDeps) {
  return async (state: State): Promise<Update> => {
    const questions = (state.intent?.ambiguity.questions ?? []).slice(0, 3);
    const raw = interrupt<ClarifyInterrupt, unknown>({ kind: "clarify", goal: state.intent?.goal ?? "", questions });
    const answers = normalizeAnswers(raw, questions.length);
    const now = deps.clock.now().toISOString();
    const events = eventsFor(state, now);
    const clarifications = questions.map((question, index) => ({
      question,
      answer: answers[index]?.trim() || "(no answer, use your best judgment)",
    }));
    events.emit("clarification.answered", { questions, answers: clarifications.map((entry) => entry.answer) });
    const input = state.input ?? { query: "", clarifications: [], submittedAt: now };
    return {
      input: { ...input, clarifications: [...input.clarifications, ...clarifications] },
      control: { ...state.control, clarifyRounds: state.control.clarifyRounds + 1, eventSeq: events.lastSeq },
      events: events.events,
    };
  };
}

function normalizeApproval(raw: unknown): unknown {
  if (raw === true || raw === "approve" || raw === "approved") return { decision: "approve" };
  return raw;
}

export function createApprovePlanNode(deps: OrchestratorDeps) {
  return async (state: State): Promise<Command> => {
    const tasks = sortedTasks(state.tasks)
      .filter((task) => !isTerminalStatus(task.status))
      .map(toTaskPreview);
    const raw = interrupt<ApprovePlanInterrupt, unknown>({
      kind: "approve_plan",
      version: state.plan.version,
      rationale: state.plan.rationale,
      tasks,
      errors: state.plan.approvalErrors,
    });

    const parsed = ApprovePlanResume.safeParse(normalizeApproval(raw));
    if (!parsed.success) {
      return new Command({
        goto: "approvePlan",
        update: { plan: { ...state.plan, approvalErrors: [`Invalid approval response: ${z.prettifyError(parsed.error)}`] } },
      });
    }
    const now = deps.clock.now().toISOString();
    const resume = parsed.data;

    if (resume.decision === "approve") {
      const events = eventsFor(state, now);
      events.emit("plan.approved", { version: state.plan.version, edited: false });
      recordDurableEvents(events.events);
      return new Command({
        goto: "reconcile",
        update: {
          plan: { ...state.plan, approved: true, approvalErrors: [] },
          control: { ...state.control, eventSeq: events.lastSeq },
          events: events.events,
        },
      });
    }

    if (resume.decision === "edit") {
      const ops: PlanOp[] = resume.ops.map((op) => ({ ...op, source: { kind: "human", taskId: null } }));
      const result = applyPlanOps(
        state.tasks,
        ops,
        {
          agents: deps.agents,
          guards: deps.config.orchestrator.guards,
          now,
          planVersion: state.plan.version,
          taskSeq: state.control.taskSeq,
          spentFingerprints: state.control.spentFingerprints,
        },
        "atomic",
      );
      if (!result.ok) {
        return new Command({ goto: "approvePlan", update: { plan: { ...state.plan, approvalErrors: result.errors } } });
      }
      const events = eventsFor(state, now, result.planVersion);
      events.emit("plan.patched", {
        version: result.planVersion,
        source: "human",
        reason: "Edited during plan approval",
        ops: result.applied.map(({ op, taskIds }) => ({ op: op.op, taskId: "taskId" in op ? op.taskId : (taskIds[0] ?? null), reason: op.reason })),
        diff: result.diff,
      });
      events.emit("plan.approved", { version: result.planVersion, edited: true });
      recordDurableEvents(events.events);
      return new Command({
        goto: "reconcile",
        update: {
          tasks: result.changed,
          plan: { ...state.plan, version: result.planVersion, approved: true, approvalErrors: [] },
          control: {
            ...state.control,
            taskSeq: result.taskSeq,
            spentFingerprints: result.spentFingerprints,
            eventSeq: events.lastSeq,
          },
          events: events.events,
        },
      });
    }

    // Rejected: cancel the proposed tasks and plan again with the reviewer's feedback.
    const events = eventsFor(state, now);
    const canceled: Record<string, Task> = {};
    for (const task of sortedTasks(state.tasks)) {
      if (isTerminalStatus(task.status)) continue;
      canceled[task.id] = { ...task, status: "canceled", statusReason: PLAN_REJECTED, updatedAt: now };
      events.emit("task.canceled", { reason: "plan rejected by reviewer", cascadeFrom: null }, { taskId: task.id, agentId: task.agentId });
    }
    events.emit("plan.rejected", { feedback: resume.feedback });
    recordDurableEvents(events.events);
    return new Command({
      goto: "planner",
      update: {
        tasks: canceled,
        plan: { ...state.plan, approved: false, intentHash: null, feedback: resume.feedback, approvalErrors: [] },
        control: { ...state.control, eventSeq: events.lastSeq },
        events: events.events,
      },
    });
  };
}

export function createHumanReviewNode(deps: OrchestratorDeps) {
  return async (state: State): Promise<Update> => {
    const requests = state.control.queues.human;
    if (requests.length === 0) return {};
    const raw = interrupt<HumanReviewInterrupt, unknown>({ kind: "human_review", requests });
    const parsed = HumanReviewResume.safeParse(raw);
    const decisions = new Map((parsed.success ? parsed.data.decisions : []).map((decision) => [decision.requestId, decision]));

    const now = deps.clock.now().toISOString();
    const control = structuredClone(state.control);
    let tasks: Record<string, Task> = { ...state.tasks };
    const changed = new Set<string>();
    const setTask = (task: Task) => {
      tasks[task.id] = { ...task, updatedAt: now };
      changed.add(task.id);
    };
    const ops: PlanOp[] = [];
    const summary: string[] = [];

    for (const request of requests) {
      const decision = decisions.get(request.id) ?? { requestId: request.id, decision: request.kind === "stalled" ? ("retry" as const) : ("skip" as const) };
      summary.push(`${request.id}: ${decision.decision}`);
      const task = request.taskId ? tasks[request.taskId] : undefined;
      switch (decision.decision) {
        case "abort":
          control.abort = { reason: "aborted by reviewer" };
          break;
        case "retry":
          if (task && request.kind === "task_failed") {
            ops.push({
              op: "retry_task",
              taskId: task.id,
              resetAttempts: true,
              instructions: decision.instructions?.trim() || null,
              agentId: null,
              reason: "Retry requested by reviewer",
              source: { kind: "human", taskId: null },
            });
          }
          if (request.kind === "stalled") control.stallCount = 0;
          break;
        case "answer": {
          const answer = decision.answer?.trim() ?? "";
          if (task && request.kind === "needs_input") {
            setTask({ ...task, status: "submitted", statusReason: "client answered", notes: [...task.notes, `Client answer: ${answer}`], assumeOnRetry: false });
          } else if (request.kind === "stalled" && answer) {
            for (const pending of sortedTasks(tasks)) {
              if (!isTerminalStatus(pending.status) && pending.status !== "working") setTask({ ...pending, notes: [...pending.notes, `Reviewer guidance: ${answer}`] });
            }
            control.stallCount = 0;
          }
          break;
        }
        case "skip":
          if (task && request.kind === "needs_input") {
            setTask({ ...task, status: "submitted", statusReason: "proceeding on assumptions", assumeOnRetry: true });
          }
          break;
      }
    }

    let planVersion = state.plan.version;
    const events = eventsFor(state, now);
    if (ops.length > 0) {
      const result = applyPlanOps(
        tasks,
        ops,
        { agents: deps.agents, guards: deps.config.orchestrator.guards, now, planVersion, taskSeq: control.taskSeq, spentFingerprints: control.spentFingerprints },
        "per-op",
      );
      tasks = result.tasks;
      for (const id of Object.keys(result.changed)) changed.add(id);
      control.taskSeq = result.taskSeq;
      control.spentFingerprints = result.spentFingerprints;
      if (result.planVersion !== planVersion) {
        planVersion = result.planVersion;
        events.setPlanVersion(planVersion);
        events.emit("plan.patched", {
          version: planVersion,
          source: "human",
          reason: "Reviewer decisions",
          ops: result.applied.map(({ op, taskIds }) => ({ op: op.op, taskId: "taskId" in op ? op.taskId : (taskIds[0] ?? null), reason: op.reason })),
          diff: result.diff,
        });
      }
    }
    events.emit("human.resolved", { requestIds: requests.map((request) => request.id), decisions: summary });
    control.humanReviews += 1;
    control.queues.human = [];
    control.eventSeq = events.lastSeq;
    recordDurableEvents(events.events);

    return {
      tasks: Object.fromEntries([...changed].map((id) => [id, tasks[id]!])),
      control,
      events: events.events,
      ...(planVersion !== state.plan.version ? { plan: { ...state.plan, version: planVersion } } : {}),
    };
  };
}
