import {
  addUsage,
  isTerminalStatus,
  type AttemptDecision,
  type ControlState,
  type GuardName,
  type HitlSettings,
  type HumanDecision,
  type HumanRequestKind,
  type IntentAnalysis,
  type LifecycleEvent,
  type OpSourceKind,
  type PlanMeta,
  type PlanOp,
  type Proposal,
  type ReplanTrigger,
  type RouteDecision,
  type RunInput,
  type RunMeta,
  type SynthesisReason,
  type Task,
  type TaskResult,
  type Tier,
  type WorkerReport,
} from "@analytax/contracts";
import type { AgentRegistry } from "../agents/registry.js";
import type { AppConfig } from "../config/load.js";
import type { ResolvedModel } from "../models/factory.js";
import { applyPlanOps, type ApplyResult } from "../planning/apply-plan-ops.js";
import { cascadeFailures } from "../planning/cascade.js";
import { compareTaskIds, dependentsIndex, sortedTasks, type TaskMap } from "../planning/dag.js";
import { allTerminal, countTasks, selectDispatches } from "../planning/readiness.js";
import { truncate, uniq } from "../util/text.js";
import { buildContextPacket } from "./context-packet.js";
import { DurableEvents, traceRefFromRun, type EventScope } from "./events.js";
import { collectGaps, stopReason } from "./gaps.js";
import { decide, feedbackFrom, type PolicyAction } from "./policy.js";
import { disposeProposals, prerequisiteOps } from "./proposals.js";
import { selectTier } from "./tier.js";

export type ReconcileState = {
  tasks: Record<string, Task>;
  results: Record<string, TaskResult>;
  inbox: Record<string, WorkerReport>;
  control: ControlState;
  plan: PlanMeta;
  run: RunMeta;
  intent: IntentAnalysis | null;
  input: RunInput | null;
};

export type ReconcileDeps = {
  agents: AgentRegistry;
  config: AppConfig;
  now: () => Date;
  resolveModel: (tier: Tier) => ResolvedModel;
};

export type ReconcileOutput = {
  /** Changed tasks only (merge-by-key reducer). */
  tasks: Record<string, Task>;
  results: Record<string, TaskResult>;
  ack: string[];
  control: ControlState;
  plan: PlanMeta | null;
  events: LifecycleEvent[];
  route: RouteDecision;
};

const DECISION: Record<PolicyAction["kind"], AttemptDecision> = {
  accept: "accepted",
  requeue: "requeued",
  retry: "retried",
  escalate: "escalated",
  reassign: "reassigned",
  block: "blocked",
  input_required: "input_required",
  replan: "replan_requested",
  human: "human_requested",
  fail: "failed",
  reject: "rejected",
};

export function failureDossier(task: Task): string {
  const attempts = task.history
    .map((record) => {
      const score = record.score === null ? "" : `, score ${record.score.toFixed(2)}`;
      const feedback = record.feedback ? ` — ${truncate(record.feedback.replace(/\s+/g, " "), 300)}` : "";
      return `- attempt ${record.attempt} by ${record.agentId} @ ${record.tier}: ${record.decision}${record.outcomeStatus ? ` (${record.outcomeStatus})` : ""}${score}${feedback}`;
    })
    .join("\n");
  return [
    `${task.id} "${task.title}" — agent ${task.agentId}, capability ${task.capability}, attempts ${task.attempt}, blocks ${task.blockCount}`,
    `Instructions: ${truncate(task.instructions, 500)}`,
    attempts || "- no attempt history",
  ].join("\n");
}

export function stallDossier(tasks: TaskMap): string {
  return sortedTasks(tasks)
    .filter((task) => !isTerminalStatus(task.status))
    .map((task) => {
      const last = task.history.at(-1);
      const waiting = task.dependsOn.filter((id) => tasks[id]?.status !== "completed");
      return `- ${task.id} [${task.status}] "${task.title}"${waiting.length ? ` waiting on ${waiting.join(", ")}` : ""}${
        last ? `; last attempt ${last.decision}: ${truncate(last.feedback.replace(/\s+/g, " "), 200)}` : ""
      }`;
    })
    .join("\n");
}

export function toTaskResult(report: WorkerReport, now: string, degraded: boolean, inlineMaxBytes: number): TaskResult {
  const outcome = report.outcome!;
  const bytes = Buffer.byteLength(outcome.output, "utf8");
  return {
    taskId: report.taskId,
    agentId: report.agentId,
    tier: report.tier,
    attempt: report.attempt,
    dispatchId: report.dispatchId,
    summary: outcome.summary,
    keyFindings: outcome.keyFindings,
    sources: outcome.sources,
    assumptions: outcome.assumptions,
    openQuestions: outcome.openQuestions,
    confidence: outcome.confidence,
    output: report.outputRef && bytes > inlineMaxBytes ? null : outcome.output,
    outputRef: report.outputRef,
    outputChars: outcome.output.length,
    score: report.verdict?.score ?? null,
    evaluatedBy: report.verdict?.evaluatedBy ?? "skipped",
    degraded,
    completedAt: now,
  };
}

class ReconcileSession {
  tasks: Record<string, Task>;
  readonly changed = new Set<string>();
  readonly results: Record<string, TaskResult> = {};
  readonly ack: string[] = [];
  control: ControlState;
  planVersion: number;
  accepted = 0;
  readonly events: DurableEvents;
  readonly nowDate: Date;
  readonly now: string;

  constructor(
    readonly state: ReconcileState,
    readonly deps: ReconcileDeps,
  ) {
    this.tasks = { ...state.tasks };
    this.control = structuredClone(state.control);
    this.planVersion = state.plan.version;
    this.nowDate = deps.now();
    this.now = this.nowDate.toISOString();
    this.events = new DurableEvents(
      this.control.eventSeq,
      { runId: state.run.runId, threadId: state.run.threadId, planVersion: this.planVersion, trace: traceRefFromRun(state.run) },
      () => this.now,
    );
  }

  get guards() {
    return this.deps.config.orchestrator.guards;
  }

  get hitl(): HitlSettings {
    return this.state.run.hitl ?? this.deps.config.orchestrator.hitl;
  }

  setTask(task: Task): void {
    this.tasks[task.id] = task;
    this.changed.add(task.id);
  }

  scope(task: Task, dispatchId: string | null = task.activeDispatchId): EventScope {
    return { taskId: task.id, agentId: task.agentId, attempt: task.attempt, wave: this.control.wave, dispatchId };
  }

  private nextRequestId(prefix: string): string {
    this.control.requestSeq += 1;
    return `${prefix}${this.control.requestSeq}`;
  }

  queueReplan(trigger: ReplanTrigger, taskId: string | null, detail: string, dossier = "", proposal: Proposal | null = null): string | null {
    if (this.control.queues.replan.some((request) => request.trigger === trigger && request.taskId === taskId)) return null;
    const id = this.nextRequestId("rp");
    this.control.queues.replan.push({ id, trigger, taskId, detail, proposal, dossier, wave: this.control.wave });
    this.events.emit("replan.requested", { requestId: id, trigger, detail: truncate(detail, 500) }, { taskId });
    return id;
  }

  queueHuman(kind: HumanRequestKind, task: Task | null, question: string, detail: string, options: HumanDecision[]): void {
    const taskId = task?.id ?? null;
    if (this.control.queues.human.some((request) => request.kind === kind && request.taskId === taskId)) return;
    this.control.queues.human.push({
      id: this.nextRequestId("hr"),
      kind,
      taskId,
      title: task?.title ?? "Run guidance",
      question,
      detail,
      options,
    });
  }

  tripGuard(guard: GuardName, detail: string): void {
    this.control.guards.tripped.push({ guard, wave: this.control.wave, detail, at: this.now });
    this.events.emit("guard.tripped", { guard, detail });
  }

  bumpPlanVersion(): void {
    this.planVersion += 1;
    this.events.setPlanVersion(this.planVersion);
  }

  applyOps(ops: PlanOp[], source: OpSourceKind, reason: string): ApplyResult {
    const result = applyPlanOps(
      this.tasks,
      ops,
      {
        agents: this.deps.agents,
        guards: this.guards,
        now: this.now,
        planVersion: this.planVersion,
        taskSeq: this.control.taskSeq,
        spentFingerprints: this.control.spentFingerprints,
      },
      "per-op",
    );
    this.tasks = result.tasks;
    for (const id of Object.keys(result.changed)) this.changed.add(id);
    this.control.taskSeq = result.taskSeq;
    this.control.spentFingerprints = result.spentFingerprints;
    if (result.planVersion !== this.planVersion) {
      this.planVersion = result.planVersion;
      this.events.setPlanVersion(this.planVersion);
      this.events.emit("plan.patched", {
        version: this.planVersion,
        source,
        reason: truncate(reason, 300),
        ops: result.applied.map(({ op, taskIds }) => ({
          op: op.op,
          taskId: "taskId" in op ? op.taskId : (taskIds[0] ?? null),
          reason: truncate(op.reason, 200),
        })),
        diff: result.diff,
      });
    }
    for (const rejected of result.rejected) {
      this.events.emit("plan.op_rejected", {
        op: rejected.op.op,
        taskId: "taskId" in rejected.op ? rejected.op.taskId : null,
        source,
        errors: rejected.errors,
      });
    }
    return result;
  }
}

function sweepOrphans(s: ReconcileSession): void {
  for (const task of sortedTasks(s.tasks)) {
    if (task.status !== "working") continue;
    if (task.activeDispatchId && s.state.inbox[task.activeDispatchId]) continue;
    if (task.activeDispatchId) delete s.control.dispatches[task.activeDispatchId];
    s.setTask({
      ...task,
      status: "submitted",
      statusReason: "orphaned dispatch requeued",
      activeDispatchId: null,
      attempt: Math.max(0, task.attempt - 1),
      infraRetries: task.infraRetries + 1,
      updatedAt: s.now,
    });
    s.events.emit(
      "task.requeued",
      { dispatchId: task.activeDispatchId ?? "", reason: "orphaned dispatch (no report)", infraRetries: task.infraRetries + 1 },
      s.scope(task, task.activeDispatchId),
    );
  }
}

function handleProposals(s: ReconcileSession, task: Task, proposals: readonly Proposal[]): void {
  if (proposals.length === 0) return;
  const dispositions = disposeProposals(
    {
      task,
      tasks: s.tasks,
      agents: s.deps.agents,
      guards: s.guards,
      autoSpawned: s.control.autoSpawned,
      autoSpawnFrozen: s.control.guards.autoSpawnFrozen,
    },
    proposals,
  );
  const scope = { taskId: task.id, agentId: task.agentId, wave: s.control.wave };
  for (const disposition of dispositions) {
    const base = { fromTaskId: task.id, kind: disposition.proposal.kind, title: disposition.proposal.title };
    if (disposition.kind === "drop") {
      s.events.emit("proposal.dropped", { ...base, reason: disposition.reason }, scope);
      continue;
    }
    if (disposition.kind === "defer") {
      const requestId = s.queueReplan(
        disposition.proposal.kind === "decompose" ? "decompose" : "proposal_deferred",
        task.id,
        `${task.id} proposed "${disposition.proposal.title}" (${disposition.reason})`,
        `${disposition.proposal.instructions}\nRationale: ${disposition.proposal.rationale}`,
        disposition.proposal,
      );
      s.events.emit("proposal.deferred", { ...base, requestId: requestId ?? "(already queued)" }, scope);
      continue;
    }
    const result = s.applyOps(disposition.ops, "proposal", disposition.proposal.rationale || `Proposal from ${task.id}: ${disposition.proposal.title}`);
    const newTaskId = disposition.primaryRef
      ? result.refs[disposition.primaryRef]
      : result.applied.find((applied) => applied.op.op === "revise_task")?.taskIds[0];
    if (newTaskId) {
      s.control.autoSpawned += 1;
      s.events.emit("proposal.accepted", { ...base, newTaskId }, scope);
    } else {
      s.events.emit("proposal.dropped", { ...base, reason: result.errors.join("; ") || "rejected by plan validation" }, scope);
    }
  }
}

function handleBlock(s: ReconcileSession, base: Task, report: WorkerReport, prerequisite: Proposal, scope: EventScope): void {
  const blocked: Task = {
    ...base,
    status: "submitted",
    statusReason: `blocked: ${truncate(prerequisite.title, 120)}`,
    attempt: Math.max(0, base.attempt - 1),
    blockCount: base.blockCount + 1,
    partialRef: report.outputRef ?? base.partialRef,
  };
  s.setTask(blocked);
  const plan = prerequisiteOps(blocked, prerequisite, s.tasks, s.deps.agents);
  let prerequisiteTaskId: string | null = null;
  if ("defer" in plan) {
    s.queueReplan("proposal_deferred", blocked.id, `${blocked.id} is blocked on "${prerequisite.title}" (${plan.defer})`, prerequisite.instructions, prerequisite);
  } else {
    const result = s.applyOps(plan.ops, "policy", `Prerequisite discovered by ${blocked.id}: ${prerequisite.title}`);
    const linked = plan.linkedTo && result.applied.length > 0 ? plan.linkedTo : null;
    prerequisiteTaskId = (plan.ref ? result.refs[plan.ref] : undefined) ?? linked;
    if (!prerequisiteTaskId) {
      s.queueReplan(
        "proposal_deferred",
        blocked.id,
        `Could not insert prerequisite "${prerequisite.title}" for ${blocked.id}: ${result.errors.join("; ")}`,
        prerequisite.instructions,
        prerequisite,
      );
    }
  }
  s.events.emit("task.blocked", { dispatchId: report.dispatchId, prerequisiteTaskId, reason: prerequisite.rationale || prerequisite.title }, scope);
}

function processReport(s: ReconcileSession, report: WorkerReport): void {
  s.ack.push(report.dispatchId);
  delete s.control.dispatches[report.dispatchId];
  const task = s.tasks[report.taskId];
  const scope: EventScope = {
    taskId: report.taskId,
    agentId: report.agentId,
    attempt: report.attempt,
    wave: report.wave,
    dispatchId: report.dispatchId,
  };
  if (!task || task.activeDispatchId !== report.dispatchId) {
    s.events.emit(
      "task.report_discarded",
      { dispatchId: report.dispatchId, reason: task ? `stale dispatch (active: ${task.activeDispatchId ?? "none"})` : "unknown task" },
      scope,
    );
    return;
  }

  s.control.usage = addUsage(s.control.usage, report.usage);
  const errorKey = report.error ? `${task.fingerprint}|${report.error.signature}` : null;
  if (errorKey) s.control.errorSigCounts[errorKey] = (s.control.errorSigCounts[errorKey] ?? 0) + 1;

  s.events.emit(
    "evaluation.completed",
    {
      dispatchId: report.dispatchId,
      attempt: report.attempt,
      tier: report.tier,
      model: report.model,
      outcomeStatus: report.outcome?.status ?? null,
      decision: report.verdict?.decision ?? null,
      score: report.verdict?.score ?? null,
      evaluatedBy: report.verdict?.evaluatedBy ?? null,
      unmetCriteria: report.verdict?.criteria.filter((criterion) => !criterion.met).map((criterion) => criterion.criterion) ?? [],
      issues: report.verdict?.issues.map((issue) => `[${issue.severity}] ${issue.text}`) ?? [],
      error: report.error ? `${report.error.kind}: ${report.error.message}` : null,
      usage: report.usage,
      judge: report.judge ?? null,
      durationMs: report.durationMs,
    },
    scope,
  );

  const card = s.deps.agents.require(task.agentId);
  const dependents = dependentsIndex(s.tasks).get(task.id) ?? [];
  const action = decide({
    task,
    report,
    card,
    altAgentId: s.deps.agents.bestFor(task.capability, [...task.triedAgents, task.agentId])?.id ?? null,
    guards: s.guards,
    degradedScore: s.deps.config.orchestrator.evaluation.degradedScore,
    hitl: s.hitl,
    humanReviewsLeft: s.guards.maxHumanReviews - s.control.humanReviews,
    replansLeft: s.guards.maxReplans - s.control.replans,
    stopRequested: stopReason(s.control, s.state.run, s.guards, s.nowDate) !== null,
    hasDependents: dependents.some((id) => {
      const dependent = s.tasks[id];
      return dependent !== undefined && !isTerminalStatus(dependent.status);
    }),
    errorRepeats: errorKey ? (s.control.errorSigCounts[errorKey] ?? 0) : 0,
    outputRepeat: report.outputFingerprint !== null && task.history.some((record) => record.outputFingerprint === report.outputFingerprint),
  });

  const feedback =
    "feedback" in action ? action.feedback : action.kind === "fail" || action.kind === "replan" || action.kind === "human" ? feedbackFrom(report) : "";
  const record = {
    attempt: report.attempt,
    dispatchId: report.dispatchId,
    agentId: report.agentId,
    tier: report.tier,
    outcomeStatus: report.outcome?.status ?? (report.error ? `error:${report.error.kind}` : null),
    decision: DECISION[action.kind],
    score: report.verdict?.score ?? null,
    feedback: truncate(feedback, 800),
    issues: (report.verdict?.issues ?? []).map((issue) => `[${issue.severity}] ${issue.text}`).slice(0, 5),
    errorSignature: report.error?.signature ?? null,
    outputFingerprint: report.outputFingerprint,
    at: s.now,
  };
  const base: Task = { ...task, activeDispatchId: null, history: [...task.history, record].slice(-3), updatedAt: s.now };
  if ((action.kind === "fail" || action.kind === "replan" || action.kind === "human") && action.guard) {
    s.tripGuard(action.guard, `${task.id} "${task.title}": ${action.guard === "error_loop" ? "same error repeated" : "blocked repeatedly"}`);
  }
  const partialRef = report.outputRef ?? task.partialRef;

  switch (action.kind) {
    case "accept": {
      const accepted: Task = { ...base, status: "completed", statusReason: null, pendingFeedback: null, assumeOnRetry: false };
      s.setTask(accepted);
      s.results[task.id] = toTaskResult(report, s.now, false, s.deps.config.orchestrator.artifacts.inlineMaxBytes);
      s.accepted += 1;
      s.events.emit(
        "task.completed",
        {
          dispatchId: report.dispatchId,
          attempt: report.attempt,
          tier: report.tier,
          score: report.verdict?.score ?? null,
          evaluatedBy: report.verdict?.evaluatedBy ?? "skipped",
          summary: truncate(report.outcome?.summary ?? "", 400),
          degraded: false,
        },
        scope,
      );
      handleProposals(s, accepted, report.outcome?.proposals ?? []);
      return;
    }
    case "requeue":
      s.setTask({
        ...base,
        status: "submitted",
        statusReason: `requeued: ${truncate(action.reason, 160)}`,
        attempt: Math.max(0, task.attempt - 1),
        infraRetries: task.infraRetries + 1,
      });
      s.events.emit("task.requeued", { dispatchId: report.dispatchId, reason: truncate(action.reason, 300), infraRetries: task.infraRetries + 1 }, scope);
      return;
    case "retry":
      s.setTask({ ...base, status: "submitted", statusReason: "retrying with feedback", pendingFeedback: action.feedback, assumeOnRetry: action.assume, partialRef });
      s.events.emit("task.retried", { dispatchId: report.dispatchId, nextAttempt: task.attempt + 1, feedback: truncate(action.feedback, 400) }, scope);
      return;
    case "escalate":
      s.setTask({ ...base, status: "submitted", statusReason: `escalated to ${action.toTier}`, tierOverride: action.toTier, pendingFeedback: action.feedback, partialRef });
      s.events.emit("task.escalated", { dispatchId: report.dispatchId, fromTier: report.tier, toTier: action.toTier, reason: "rejected again at the current tier" }, scope);
      return;
    case "reassign":
      s.setTask({
        ...base,
        status: "submitted",
        statusReason: `reassigned to ${action.toAgentId}`,
        agentId: action.toAgentId,
        tierOverride: null,
        pendingFeedback: action.feedback,
        partialRef,
      });
      s.events.emit("task.reassigned", { dispatchId: report.dispatchId, fromAgentId: task.agentId, toAgentId: action.toAgentId, reason: "previous agent could not satisfy the criteria" }, scope);
      return;
    case "block":
      handleBlock(s, base, report, action.prerequisite, scope);
      return;
    case "input_required": {
      const next: Task = { ...base, status: "input-required", statusReason: truncate(action.questions.join(" "), 200), partialRef };
      s.setTask(next);
      s.queueHuman("needs_input", next, action.questions.join("\n"), `${task.id} "${task.title}" needs information only the client can provide.`, ["answer", "skip", "abort"]);
      s.events.emit("task.input_required", { dispatchId: report.dispatchId, questions: action.questions }, scope);
      return;
    }
    case "replan": {
      const next: Task = { ...base, status: "failed", statusReason: "recovery ladder exhausted, replan requested", partialRef };
      s.setTask(next);
      s.events.emit("task.failed", { dispatchId: report.dispatchId, reason: next.statusReason!, degraded: false }, scope);
      s.queueReplan(action.trigger, task.id, action.detail, failureDossier(next));
      return;
    }
    case "human": {
      const next: Task = { ...base, status: "failed", statusReason: "awaiting human review", partialRef };
      s.setTask(next);
      s.events.emit("task.failed", { dispatchId: report.dispatchId, reason: next.statusReason!, degraded: false }, scope);
      s.queueHuman("task_failed", next, action.question, failureDossier(next), ["retry", "skip", "abort"]);
      return;
    }
    case "fail":
      s.setTask({ ...base, status: "failed", statusReason: action.reason, partialRef });
      if (action.degraded && report.outcome) {
        s.results[task.id] = toTaskResult(report, s.now, true, s.deps.config.orchestrator.artifacts.inlineMaxBytes);
      }
      s.events.emit("task.failed", { dispatchId: report.dispatchId, reason: action.reason, degraded: action.degraded }, scope);
      return;
    case "reject":
      s.setTask({ ...base, status: "rejected", statusReason: action.reason });
      s.events.emit("task.rejected", { reason: action.reason }, scope);
      return;
  }
}

function sweepCascade(s: ReconcileSession): void {
  const held = new Set(
    [...s.control.queues.replan, ...s.control.queues.human].map((request) => request.taskId).filter((id): id is string => id !== null),
  );
  const cascade = cascadeFailures(s.tasks, {
    now: s.now,
    replanAvailable: s.control.replans < s.guards.maxReplans,
    heldTaskIds: held,
    upstreamReplanned: new Set(s.control.upstreamReplanned),
  });
  if (Object.keys(cascade.changed).length === 0 && cascade.replanFor.length === 0) return;
  s.tasks = cascade.tasks;
  for (const id of Object.keys(cascade.changed)) s.changed.add(id);

  const rewiredIds = uniq([...cascade.dropped.map((drop) => drop.taskId), ...cascade.rewired.map((rewire) => rewire.taskId)]);
  if (rewiredIds.length > 0) {
    s.bumpPlanVersion();
    s.events.emit("plan.patched", {
      version: s.planVersion,
      source: "policy",
      reason: "Upstream failures handled: optional inputs dropped, failed revisions fell back to their originals",
      ops: [],
      diff: {
        added: [],
        updated: [],
        canceled: [],
        rewired: rewiredIds.sort(compareTaskIds).map((taskId) => ({ taskId, dependsOn: s.tasks[taskId]?.dependsOn ?? [] })),
      },
    });
  }
  for (const canceled of cascade.canceled) {
    const task = s.tasks[canceled.taskId];
    if (task) s.events.emit("task.canceled", { reason: canceled.reason, cascadeFrom: canceled.cascadeFrom }, s.scope(task, null));
  }
  for (const request of cascade.replanFor) {
    const failed = s.tasks[request.failedTaskId];
    if (!failed) continue;
    s.control.upstreamReplanned.push(failed.id);
    s.queueReplan(
      "upstream_failed",
      failed.id,
      `${failed.id} "${failed.title}" is ${failed.status} (${failed.statusReason ?? "no reason"}); critical dependents waiting: ${request.dependentIds.join(", ")}`,
      failureDossier(failed),
    );
  }
}

function updateProgress(s: ReconcileSession, reports: number): void {
  if (reports === 0) return;
  const progress = s.accepted > 0;
  s.control.stallCount = progress ? 0 : s.control.stallCount + 1;
  if (progress) s.control.lastProgressWave = s.control.wave;

  const counts = countTasks(s.tasks);
  const terminal = counts.completed + counts.failed + counts.canceled + counts.rejected;
  const { growthFreeze } = s.guards;
  s.control.growth = [...s.control.growth, { wave: s.control.wave, total: counts.total, completed: terminal }].slice(-(growthFreeze.windowWaves + 1));
  const first = s.control.growth[0];
  const last = s.control.growth.at(-1);
  if (
    first &&
    last &&
    !s.control.guards.autoSpawnFrozen &&
    s.control.growth.length > growthFreeze.windowWaves &&
    last.total - last.completed > growthFreeze.outstanding &&
    last.total >= first.total * growthFreeze.factor
  ) {
    s.control.guards.autoSpawnFrozen = true;
    s.tripGuard("auto_spawn_frozen", `plan grew from ${first.total} to ${last.total} tasks with ${last.total - last.completed} outstanding`);
  }

  const durationMs = s.control.waveStartedAt ? Math.max(0, s.nowDate.getTime() - Date.parse(s.control.waveStartedAt)) : 0;
  s.events.emit("wave.completed", { wave: s.control.wave, reports, durationMs, progress, stallCount: s.control.stallCount }, { wave: s.control.wave });
  s.control.waveStartedAt = null;

  if (progress) return;
  if (s.control.stallCount === s.guards.stallReplanAt && s.control.replans < s.guards.maxReplans) {
    s.tripGuard("stall", `no task accepted in ${s.control.stallCount} waves, forcing a replan`);
    s.queueReplan("stall", null, `No task has been accepted in the last ${s.control.stallCount} waves.`, stallDossier(s.tasks));
  } else if (s.control.stallCount >= s.guards.stallStopAt) {
    if (s.hitl.humanReview && s.control.humanReviews < s.guards.maxHumanReviews) {
      s.queueHuman("stalled", null, "The run is not making progress. Provide guidance, retry, or abort?", stallDossier(s.tasks), ["answer", "retry", "abort"]);
    } else {
      s.tripGuard("stall", `no progress in ${s.control.stallCount} waves, stopping`);
      s.control.abort = { reason: "stalled" };
    }
  }
}

function synthesize(s: ReconcileSession, reason: SynthesisReason): RouteDecision {
  const completed = Object.values(s.tasks).filter((task) => task.status === "completed").length;
  s.events.emit("synthesis.started", { reason, completed, gaps: collectGaps(s.tasks).length });
  return { kind: "synthesize", reason };
}

function dispatch(s: ReconcileSession, ready: readonly Task[]): RouteDecision {
  s.control.wave += 1;
  s.control.waveStartedAt = s.now;
  const dispatchIds: string[] = [];
  for (const task of ready) {
    const card = s.deps.agents.require(task.agentId);
    const tier = selectTier(task, card);
    const resolved = s.deps.resolveModel(tier);
    const attempt = task.attempt + 1;
    const dispatchId = `${task.id}.a${attempt}.w${s.control.wave}`;
    const next: Task = {
      ...task,
      status: "working",
      statusReason: null,
      attempt,
      currentTier: tier,
      activeDispatchId: dispatchId,
      triedAgents: uniq([...task.triedAgents, task.agentId]),
      updatedAt: s.now,
    };
    s.setTask(next);
    s.control.dispatches[dispatchId] = {
      dispatchId,
      taskId: task.id,
      attempt,
      wave: s.control.wave,
      agentId: task.agentId,
      tier,
      model: resolved.model,
      dispatchedAt: s.now,
    };
    const packet = buildContextPacket(
      next,
      { tasks: s.tasks, results: { ...s.state.results, ...s.results }, intent: s.state.intent, input: s.state.input },
      resolved.contextTokens,
    );
    s.events.emit(
      "task.dispatched",
      { dispatchId, attempt, tier, agentId: task.agentId, model: resolved.model, packetTokens: packet.budget.usedTokens },
      { taskId: task.id, agentId: task.agentId, attempt, wave: s.control.wave, dispatchId },
    );
    dispatchIds.push(dispatchId);
  }
  s.events.emit("wave.started", { wave: s.control.wave, dispatchIds }, { wave: s.control.wave });
  return { kind: "dispatch", dispatchIds };
}

function autoResolveHuman(s: ReconcileSession): void {
  for (const request of s.control.queues.human) {
    const task = request.taskId ? s.tasks[request.taskId] : undefined;
    if (request.kind === "needs_input" && task) {
      s.setTask({ ...task, status: "submitted", statusReason: "proceeding on stated assumptions", assumeOnRetry: true, updatedAt: s.now });
    }
    if (request.kind === "stalled") s.control.abort = { reason: "stalled" };
  }
  s.control.queues.human = [];
}

function decideRoute(s: ReconcileSession): RouteDecision {
  const stop = stopReason(s.control, s.state.run, s.guards, s.nowDate);
  if (stop) {
    if (stop === "deadline" || stop === "budget" || stop === "max_waves") {
      s.tripGuard(stop, `${stop.replace("_", " ")} reached, synthesizing with the results available`);
    }
    return synthesize(s, stop === "aborted" && s.control.abort?.reason === "stalled" ? "stall" : stop);
  }

  if (s.control.queues.human.length > 0) {
    if (s.hitl.humanReview && s.control.humanReviews < s.guards.maxHumanReviews) {
      s.events.emit("human.requested", {
        requestIds: s.control.queues.human.map((request) => request.id),
        kinds: s.control.queues.human.map((request) => request.kind),
      });
      return { kind: "human_review" };
    }
    autoResolveHuman(s);
    if (s.control.abort) return synthesize(s, "stall");
    sweepCascade(s);
  }

  if (s.control.queues.replan.length > 0) {
    if (s.control.replans < s.guards.maxReplans) return { kind: "replan" };
    s.tripGuard("max_replans", `replan limit (${s.guards.maxReplans}) reached; ${s.control.queues.replan.length} request(s) dropped`);
    s.control.queues.replan = [];
    sweepCascade(s);
    s.control.queues.replan = [];
  }

  const limit = Math.max(1, s.state.run.maxConcurrency ?? s.guards.maxConcurrency);
  const ready = selectDispatches(s.tasks, limit);
  if (ready.length > 0) return dispatch(s, ready);

  const remaining = sortedTasks(s.tasks).filter((task) => !isTerminalStatus(task.status));
  if (remaining.length === 0 || allTerminal(s.tasks)) return synthesize(s, collectGaps(s.tasks).length > 0 ? "partial" : "complete");

  // Nothing can run and nothing is running: deadlock. Ask the replanner once per remaining replan; else cancel.
  if (s.control.replans < s.guards.maxReplans) {
    const detail = remaining
      .map((task) => `${task.id} [${task.status}] waiting on ${task.dependsOn.filter((id) => s.tasks[id]?.status !== "completed").join(", ") || "nothing"}`)
      .join("; ");
    s.queueReplan("deadlock", null, `No task can run. Stuck: ${detail}`, stallDossier(s.tasks));
    return { kind: "replan" };
  }
  for (const task of remaining) {
    s.setTask({ ...task, status: "canceled", statusReason: "deadlock", activeDispatchId: null, updatedAt: s.now });
    s.events.emit("task.canceled", { reason: "deadlock", cascadeFrom: null }, s.scope(task, null));
  }
  s.tripGuard("deadlock", `canceled ${remaining.length} task(s) that could not run`);
  return synthesize(s, "deadlock");
}

/**
 * The single writer of the task ledger. Processes worker reports in deterministic order, applies the recovery
 * policy and proposals, propagates failures, tracks progress, and decides what happens next.
 */
export function reconcile(state: ReconcileState, deps: ReconcileDeps): ReconcileOutput {
  const s = new ReconcileSession(state, deps);
  sweepOrphans(s);
  const reports = Object.values(state.inbox).sort(
    (a, b) => compareTaskIds(a.taskId, b.taskId) || (a.dispatchId < b.dispatchId ? -1 : a.dispatchId > b.dispatchId ? 1 : 0),
  );
  for (const report of reports) processReport(s, report);
  sweepCascade(s);
  updateProgress(s, reports.length);
  const route = decideRoute(s);
  s.control.route = route;
  s.control.eventSeq = s.events.lastSeq;
  const tasks = Object.fromEntries([...s.changed].sort(compareTaskIds).map((id) => [id, s.tasks[id]!]));
  return {
    tasks,
    results: s.results,
    ack: s.ack,
    control: s.control,
    plan: s.planVersion !== state.plan.version ? { ...state.plan, version: s.planVersion } : null,
    events: s.events.events,
    route,
  };
}
