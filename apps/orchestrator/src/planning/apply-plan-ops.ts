import {
  clampTier,
  isTerminalStatus,
  toTaskPreview,
  type NewTask,
  type OpSourceKind,
  type PlanDiff,
  type PlanOp,
  type Task,
  type TaskOrigin,
  type TaskOriginKind,
  type TaskPreview,
  type Tier,
} from "@analytax/contracts";
import { uniq } from "../util/text.js";
import { ancestors, compareTaskIds, dependentsIndex, findCycle, type TaskMap } from "./dag.js";
import { findDuplicateTask, taskFingerprint } from "./fingerprint.js";
import { MUTABLE_STATUSES } from "./readiness.js";

/** What the plan kernel needs to know about agents (implemented by the agent registry). */
export interface AgentDirectory {
  has(agentId: string): boolean;
  capabilitiesOf(agentId: string): readonly string[];
  tierRange(agentId: string): { minTier: Tier; maxTier: Tier } | null;
}

export interface PlanGuards {
  maxTotalTasks: number;
  maxSpawnDepth: number;
  maxOpsPerPatch: number;
  maxRevisionsPerTask: number;
}

export interface ApplyContext {
  agents: AgentDirectory;
  guards: PlanGuards;
  now: string;
  planVersion: number;
  taskSeq: number;
  spentFingerprints: readonly string[];
}

export type ApplyMode = "atomic" | "per-op";

export type AppliedOp = { index: number; op: PlanOp; taskIds: string[] };
export type RejectedOp = { index: number; op: PlanOp; errors: string[]; duplicateOf: string | null };

export interface ApplyResult {
  /** atomic: every op applied; per-op: always true. */
  ok: boolean;
  tasks: Record<string, Task>;
  /** Only tasks that were created or modified (feed to the merge-by-key state reducer). */
  changed: Record<string, Task>;
  refs: Record<string, string>;
  applied: AppliedOp[];
  rejected: RejectedOp[];
  diff: PlanDiff;
  planVersion: number;
  taskSeq: number;
  spentFingerprints: string[];
  /** Flattened, LLM-readable validation errors (for repair prompts). */
  errors: string[];
}

/** statusReason for tasks canceled because the reviewer rejected their plan. */
export const PLAN_REJECTED = "plan_rejected";

const ORIGIN_BY_SOURCE: Readonly<Record<OpSourceKind, TaskOriginKind>> = {
  planner: "plan",
  replanner: "replan",
  proposal: "proposal",
  policy: "proposal",
  human: "human",
};

type OpOutcome = { errors: string[]; taskIds: string[]; duplicateOf: string | null };
const ok = (taskIds: string[] = []): OpOutcome => ({ errors: [], taskIds, duplicateOf: null });
const fail = (...errors: string[]): OpOutcome => ({ errors, taskIds: [], duplicateOf: null });

class Draft {
  readonly tasks: Map<string, Task>;
  readonly refs: Map<string, string>;
  readonly spent: Set<string>;
  taskSeq: number;

  constructor(tasks: Map<string, Task>, refs: Map<string, string>, spent: Set<string>, taskSeq: number) {
    this.tasks = tasks;
    this.refs = refs;
    this.spent = spent;
    this.taskSeq = taskSeq;
  }

  static from(base: TaskMap, ctx: ApplyContext): Draft {
    return new Draft(new Map(Object.entries(base)), new Map(), new Set(ctx.spentFingerprints), ctx.taskSeq);
  }

  clone(): Draft {
    return new Draft(new Map(this.tasks), new Map(this.refs), new Set(this.spent), this.taskSeq);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  set(task: Task): void {
    this.tasks.set(task.id, task);
  }

  resolve(idOrRef: string): string | undefined {
    const trimmed = idOrRef.trim();
    return this.refs.get(trimmed) ?? (this.tasks.has(trimmed) ? trimmed : undefined);
  }

  nextId(): string {
    this.taskSeq += 1;
    return `t${this.taskSeq}`;
  }

  record(): Record<string, Task> {
    return Object.fromEntries(this.tasks);
  }

  /** Tasks that count toward the total-task cap (superseded split parents and rejected plans don't). */
  countable(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "canceled" && (task.supersededBy.length > 0 || task.statusReason === PLAN_REJECTED)) continue;
      count++;
    }
    return count;
  }

  /** Tasks from a plan the reviewer rejected — the replacement plan may legitimately repeat them. */
  rejectedPlanIds(): Set<string> {
    const ids = new Set<string>();
    for (const task of this.tasks.values()) if (task.status === "canceled" && task.statusReason === PLAN_REJECTED) ids.add(task.id);
    return ids;
  }
}

export function createTask(args: {
  id: string;
  spec: NewTask;
  origin: TaskOrigin;
  now: string;
  revisionOf?: string | null;
}): Task {
  const { spec } = args;
  return {
    title: spec.title.trim(),
    instructions: spec.instructions.trim(),
    acceptanceCriteria: spec.acceptanceCriteria,
    checks: spec.checks,
    capability: spec.capability,
    agentId: spec.agentId,
    complexity: spec.complexity,
    tierOverride: spec.tierOverride,
    dependsOn: uniq(spec.dependsOn),
    dependencyPolicy: spec.dependencyPolicy,
    contextFrom: uniq(spec.contextFrom),
    critical: spec.critical,
    evaluation: spec.evaluation,
    id: args.id,
    status: "submitted",
    statusReason: null,
    origin: args.origin,
    fingerprint: taskFingerprint(spec),
    attempt: 0,
    infraRetries: 0,
    blockCount: 0,
    triedAgents: [],
    currentTier: null,
    activeDispatchId: null,
    history: [],
    notes: [],
    pendingFeedback: null,
    assumeOnRetry: false,
    partialRef: null,
    supersededBy: [],
    revisionOf: args.revisionOf ?? null,
    revisions: 0,
    staleInputs: false,
    createdAt: args.now,
    updatedAt: args.now,
  };
}

function validateAgent(ctx: ApplyContext, agentId: string, capability: string): string[] {
  if (!ctx.agents.has(agentId)) return [`unknown agent '${agentId}'`];
  const capabilities = ctx.agents.capabilitiesOf(agentId);
  if (!capabilities.includes(capability)) {
    return [`agent '${agentId}' does not offer capability '${capability}' (offers: ${capabilities.join(", ")})`];
  }
  return [];
}

function clampOverride(ctx: ApplyContext, agentId: string, tier: Tier | null): Tier | null {
  if (!tier) return null;
  const range = ctx.agents.tierRange(agentId);
  return range ? clampTier(tier, range.minTier, range.maxTier) : tier;
}

function resolveAll(draft: Draft, ids: readonly string[], field: string, errors: string[], local?: Map<string, string>): string[] {
  const resolved: string[] = [];
  for (const raw of ids) {
    const value = raw.trim();
    if (!value) continue;
    const id = local?.get(value) ?? draft.resolve(value);
    if (id) resolved.push(id);
    else errors.push(`${field} references unknown task or ref '${value}'`);
  }
  return uniq(resolved);
}

const replaceIn = (list: readonly string[], from: string, to: readonly string[]): string[] =>
  list.includes(from) ? uniq(list.flatMap((item) => (item === from ? to : [item]))) : [...list];

function touch(task: Task, now: string, patch: Partial<Task>): Task {
  return { ...task, ...patch, updatedAt: now };
}

// ---------------------------------------------------------------------------------------------------------------

function addTask(draft: Draft, op: Extract<PlanOp, { op: "add_task" }>, ctx: ApplyContext): OpOutcome {
  const errors: string[] = [];
  const spec = op.task;
  if (draft.countable() >= ctx.guards.maxTotalTasks) errors.push(`task limit reached (max ${ctx.guards.maxTotalTasks})`);
  errors.push(...validateAgent(ctx, spec.agentId, spec.capability));
  if (op.ref && draft.refs.has(op.ref)) errors.push(`duplicate ref '${op.ref}'`);
  const dependsOn = resolveAll(draft, spec.dependsOn, "dependsOn", errors);
  const contextFrom = resolveAll(draft, spec.contextFrom, "contextFrom", errors);

  const parent = op.source.taskId ? draft.get(op.source.taskId) : undefined;
  const originKind = op.originKind ?? ORIGIN_BY_SOURCE[op.source.kind];
  const depth = originKind === "proposal" ? (parent?.origin.depth ?? 0) + 1 : (parent?.origin.depth ?? 0);
  if (originKind === "proposal" && depth > ctx.guards.maxSpawnDepth) {
    errors.push(`spawn depth ${depth} exceeds the maximum of ${ctx.guards.maxSpawnDepth}`);
  }

  const duplicate = findDuplicateTask(draft.tasks.values(), spec, {
    near: originKind === "proposal",
    excludeIds: draft.rejectedPlanIds(),
  });
  if (duplicate) {
    errors.push(
      `duplicate of existing task ${duplicate.id} ("${duplicate.title}", ${duplicate.status})${
        isTerminalStatus(duplicate.status) && duplicate.status !== "completed" ? " — use retry_task instead" : ""
      }`,
    );
  } else if (draft.spent.has(taskFingerprint(spec))) {
    errors.push("duplicate of a task that was already superseded");
  }
  if (errors.length > 0) return { errors, taskIds: [], duplicateOf: duplicate?.id ?? null };

  const id = draft.nextId();
  draft.set(
    createTask({
      id,
      spec: { ...spec, dependsOn, contextFrom, tierOverride: clampOverride(ctx, spec.agentId, spec.tierOverride) },
      origin: { kind: originKind, parentTaskId: parent?.id ?? null, planVersion: ctx.planVersion + 1, depth },
      now: ctx.now,
    }),
  );
  if (op.ref) draft.refs.set(op.ref, id);
  return ok([id]);
}

function updateTask(draft: Draft, op: Extract<PlanOp, { op: "update_task" }>, ctx: ApplyContext): OpOutcome {
  const task = draft.get(op.taskId);
  if (!task) return fail(`unknown task '${op.taskId}'`);
  if (!MUTABLE_STATUSES.has(task.status)) {
    return fail(`cannot update ${task.id} while it is ${task.status}${task.status === "completed" ? " (use revise_task)" : ""}`);
  }
  const { patch } = op;
  const agentId = patch.agentId ?? task.agentId;
  const capability = patch.capability ?? task.capability;
  const errors = patch.agentId !== undefined || patch.capability !== undefined ? validateAgent(ctx, agentId, capability) : [];
  if (errors.length > 0) return { errors, taskIds: [], duplicateOf: null };

  const title = patch.title ?? task.title;
  const instructions = patch.instructions ?? task.instructions;
  const agentChanged = agentId !== task.agentId;
  const tierOverride =
    patch.tierOverride !== undefined
      ? clampOverride(ctx, agentId, patch.tierOverride)
      : agentChanged
        ? null
        : task.tierOverride;

  draft.set(
    touch(task, ctx.now, {
      title,
      instructions,
      acceptanceCriteria: patch.acceptanceCriteria ?? task.acceptanceCriteria,
      agentId,
      capability,
      tierOverride,
      critical: patch.critical ?? task.critical,
      dependencyPolicy: patch.dependencyPolicy ?? task.dependencyPolicy,
      pendingFeedback: patch.feedback ?? task.pendingFeedback,
      fingerprint: taskFingerprint({ capability, title, instructions }),
    }),
  );
  return ok([task.id]);
}

function cancelTask(draft: Draft, op: Extract<PlanOp, { op: "cancel_task" }>, ctx: ApplyContext): OpOutcome {
  const task = draft.get(op.taskId);
  if (!task) return fail(`unknown task '${op.taskId}'`);
  if (isTerminalStatus(task.status)) return fail(`${task.id} is already ${task.status}`);
  if (task.status === "working") return fail(`${task.id} is currently running and cannot be canceled`);
  draft.set(
    touch(task, ctx.now, { status: "canceled", statusReason: op.reason || "canceled by plan change", activeDispatchId: null }),
  );
  if (op.cascade === "drop_dependency") {
    for (const dependent of draft.tasks.values()) {
      if (isTerminalStatus(dependent.status) || !dependent.dependsOn.includes(task.id)) continue;
      draft.set(
        touch(dependent, ctx.now, {
          dependsOn: dependent.dependsOn.filter((id) => id !== task.id),
          contextFrom: dependent.contextFrom.filter((id) => id !== task.id),
          notes: [...dependent.notes, `Dependency ${task.id} ("${task.title}") was canceled: ${op.reason || "plan change"}`],
        }),
      );
    }
  }
  return ok([task.id]);
}

function editDependency(
  draft: Draft,
  op: Extract<PlanOp, { op: "add_dependency" | "remove_dependency" }>,
  ctx: ApplyContext,
): OpOutcome {
  const task = draft.get(op.taskId);
  if (!task) return fail(`unknown task '${op.taskId}'`);
  if (!MUTABLE_STATUSES.has(task.status)) {
    return fail(
      `cannot change dependencies of ${task.id} while it is ${task.status}${
        task.status === "completed" ? " (use revise_task to redo completed work)" : ""
      }`,
    );
  }
  const dependency = draft.resolve(op.dependsOn);
  if (!dependency) return fail(`unknown dependency '${op.dependsOn}'`);
  if (dependency === task.id) return fail(`${task.id} cannot depend on itself`);

  if (op.op === "add_dependency") {
    if (task.dependsOn.includes(dependency)) return ok([task.id]);
    draft.set(touch(task, ctx.now, { dependsOn: [...task.dependsOn, dependency] }));
  } else {
    if (!task.dependsOn.includes(dependency)) return fail(`${task.id} does not depend on ${dependency}`);
    draft.set(touch(task, ctx.now, { dependsOn: task.dependsOn.filter((id) => id !== dependency) }));
  }
  return ok([task.id]);
}

const SPLITTABLE = new Set(["submitted", "input-required", "failed", "rejected"]);

function splitTask(draft: Draft, op: Extract<PlanOp, { op: "split_task" }>, ctx: ApplyContext): OpOutcome {
  const task = draft.get(op.taskId);
  if (!task) return fail(`unknown task '${op.taskId}'`);
  if (!SPLITTABLE.has(task.status)) return fail(`cannot split ${task.id} while it is ${task.status}`);
  const errors: string[] = [];
  if (draft.countable() - 1 + op.subtasks.length > ctx.guards.maxTotalTasks) {
    errors.push(`splitting into ${op.subtasks.length} subtasks exceeds the task limit (max ${ctx.guards.maxTotalTasks})`);
  }

  const local = new Map<string, string>();
  for (const subtask of op.subtasks) {
    if (local.has(subtask.ref) || draft.refs.has(subtask.ref)) errors.push(`duplicate ref '${subtask.ref}'`);
    local.set(subtask.ref, `__pending_${subtask.ref}`);
    errors.push(...validateAgent(ctx, subtask.agentId, subtask.capability));
    const duplicate = findDuplicateTask(draft.tasks.values(), subtask, { near: false, excludeIds: new Set([task.id]) });
    if (duplicate) errors.push(`subtask '${subtask.ref}' duplicates existing task ${duplicate.id}`);
  }
  if (errors.length > 0) return { errors, taskIds: [], duplicateOf: null };

  for (const subtask of op.subtasks) local.set(subtask.ref, draft.nextId());
  const ids = op.subtasks.map((subtask) => local.get(subtask.ref)!);

  const created: Task[] = op.subtasks.map((subtask) => {
    const dependsOn = resolveAll(draft, subtask.dependsOn, `subtask '${subtask.ref}' dependsOn`, errors, local);
    const contextFrom = resolveAll(draft, subtask.contextFrom, `subtask '${subtask.ref}' contextFrom`, errors, local);
    return createTask({
      id: local.get(subtask.ref)!,
      spec: {
        ...subtask,
        dependsOn: dependsOn.length > 0 ? dependsOn : task.dependsOn,
        contextFrom: uniq([...contextFrom, ...task.contextFrom]),
        tierOverride: clampOverride(ctx, subtask.agentId, subtask.tierOverride),
      },
      origin: { kind: "split", parentTaskId: task.id, planVersion: ctx.planVersion + 1, depth: task.origin.depth },
      now: ctx.now,
    });
  });

  const dependedOn = new Set(created.flatMap((subtask) => subtask.dependsOn));
  const sinks =
    op.sinks.length > 0
      ? resolveAll(draft, op.sinks, "sinks", errors, local)
      : ids.filter((id) => !dependedOn.has(id));
  if (sinks.length === 0) errors.push("split has no sink subtasks");
  if (errors.length > 0) return { errors, taskIds: [], duplicateOf: null };

  for (const subtask of created) draft.set(subtask);
  for (const [ref, id] of local) draft.refs.set(ref, id);
  for (const dependent of [...draft.tasks.values()]) {
    if (ids.includes(dependent.id) || dependent.id === task.id || isTerminalStatus(dependent.status)) continue;
    if (!dependent.dependsOn.includes(task.id) && !dependent.contextFrom.includes(task.id)) continue;
    draft.set(
      touch(dependent, ctx.now, {
        dependsOn: replaceIn(dependent.dependsOn, task.id, sinks),
        contextFrom: replaceIn(dependent.contextFrom, task.id, sinks),
      }),
    );
  }
  draft.set(
    touch(task, ctx.now, { status: "canceled", statusReason: "superseded", supersededBy: ids, activeDispatchId: null }),
  );
  draft.spent.add(task.fingerprint);
  return ok(ids);
}

function reviseTask(draft: Draft, op: Extract<PlanOp, { op: "revise_task" }>, ctx: ApplyContext): OpOutcome {
  const task = draft.get(op.taskId);
  if (!task) return fail(`unknown task '${op.taskId}'`);
  if (task.status !== "completed") return fail(`revise_task requires a completed task; ${task.id} is ${task.status}`);
  if (task.revisions >= ctx.guards.maxRevisionsPerTask) {
    return fail(`${task.id} already has ${task.revisions} revision(s) (max ${ctx.guards.maxRevisionsPerTask})`);
  }
  if (draft.countable() >= ctx.guards.maxTotalTasks) return fail(`task limit reached (max ${ctx.guards.maxTotalTasks})`);
  const errors: string[] = [];
  const waitFor = resolveAll(draft, op.waitFor, "waitFor", errors).filter((id) => id !== task.id);
  if (errors.length > 0) return { errors, taskIds: [], duplicateOf: null };

  const title = `${task.title} (revision ${task.revisions + 1})`;
  const duplicate = findDuplicateTask(draft.tasks.values(), { capability: task.capability, title, instructions: op.instructions }, { near: false });
  if (duplicate) return { errors: [`duplicate of existing task ${duplicate.id}`], taskIds: [], duplicateOf: duplicate.id };

  const id = draft.nextId();
  const revision = createTask({
    id,
    spec: {
      title,
      instructions: op.instructions,
      acceptanceCriteria: task.acceptanceCriteria,
      checks: task.checks,
      capability: task.capability,
      agentId: task.agentId,
      complexity: task.complexity,
      tierOverride: task.tierOverride,
      dependsOn: [...waitFor, task.id],
      dependencyPolicy: "all",
      contextFrom: task.contextFrom,
      // The completed original remains a valid fallback, so a failed revision never blocks the critical path.
      critical: false,
      evaluation: task.evaluation,
    },
    origin: { kind: "revision", parentTaskId: task.id, planVersion: ctx.planVersion + 1, depth: task.origin.depth },
    now: ctx.now,
    revisionOf: task.id,
  });
  draft.set(revision);
  draft.set(touch(task, ctx.now, { revisions: task.revisions + 1, supersededBy: [...task.supersededBy, id] }));

  // Don't rewire anything the revision itself waits on (directly or transitively) — that would create a cycle.
  const protectedIds = new Set<string>(waitFor);
  const snapshot = draft.record();
  for (const waitId of waitFor) for (const ancestor of ancestors(snapshot, waitId)) protectedIds.add(ancestor);

  const index = dependentsIndex(snapshot);
  for (const dependentId of index.get(task.id) ?? []) {
    const dependent = draft.get(dependentId);
    if (!dependent || dependentId === id || protectedIds.has(dependentId)) continue;
    if (MUTABLE_STATUSES.has(dependent.status)) {
      draft.set(
        touch(dependent, ctx.now, {
          dependsOn: replaceIn(dependent.dependsOn, task.id, [id]),
          contextFrom: replaceIn(dependent.contextFrom, task.id, [id]),
        }),
      );
    } else if (dependent.status === "completed") {
      draft.set(touch(dependent, ctx.now, { staleInputs: true }));
    }
  }
  return ok([id]);
}

const RETRYABLE = new Set(["failed", "canceled", "rejected"]);

function retryTask(draft: Draft, op: Extract<PlanOp, { op: "retry_task" }>, ctx: ApplyContext): OpOutcome {
  const task = draft.get(op.taskId);
  if (!task) return fail(`unknown task '${op.taskId}'`);
  if (!RETRYABLE.has(task.status)) return fail(`retry_task requires a failed/canceled/rejected task; ${task.id} is ${task.status}`);
  if (task.supersededBy.length > 0 && task.status === "canceled") return fail(`${task.id} was superseded and cannot be retried`);
  const agentId = op.agentId ?? task.agentId;
  if (op.agentId) {
    const errors = validateAgent(ctx, agentId, task.capability);
    if (errors.length > 0) return { errors, taskIds: [], duplicateOf: null };
  }
  const instructions = op.instructions ?? task.instructions;
  const reset = op.resetAttempts;
  draft.set(
    touch(task, ctx.now, {
      status: "submitted",
      statusReason: "retry requested",
      instructions,
      agentId,
      fingerprint: taskFingerprint({ capability: task.capability, title: task.title, instructions }),
      attempt: reset ? 0 : task.attempt,
      infraRetries: reset ? 0 : task.infraRetries,
      blockCount: reset ? 0 : task.blockCount,
      triedAgents: reset ? [] : task.triedAgents,
      tierOverride: null,
      activeDispatchId: null,
      pendingFeedback: op.reason || task.pendingFeedback,
    }),
  );

  // Revive dependents that were canceled only because this task failed.
  const revived: string[] = [task.id];
  const queue = [task.id];
  while (queue.length > 0) {
    const failedId = queue.shift()!;
    for (const dependent of [...draft.tasks.values()].sort((a, b) => compareTaskIds(a.id, b.id))) {
      if (dependent.status !== "canceled" || dependent.statusReason !== `upstream_failed:${failedId}`) continue;
      draft.set(touch(dependent, ctx.now, { status: "submitted", statusReason: null }));
      revived.push(dependent.id);
      queue.push(dependent.id);
    }
  }
  return ok(revived);
}

function applyOne(draft: Draft, op: PlanOp, ctx: ApplyContext): OpOutcome {
  switch (op.op) {
    case "add_task":
      return addTask(draft, op, ctx);
    case "update_task":
      return updateTask(draft, op, ctx);
    case "cancel_task":
      return cancelTask(draft, op, ctx);
    case "add_dependency":
    case "remove_dependency":
      return editDependency(draft, op, ctx);
    case "split_task":
      return splitTask(draft, op, ctx);
    case "revise_task":
      return reviseTask(draft, op, ctx);
    case "retry_task":
      return retryTask(draft, op, ctx);
  }
}

const PREVIEW_KEYS = ["title", "instructions", "agentId", "capability", "complexity", "critical", "status"] as const;

function computeDiff(before: TaskMap, after: Map<string, Task>): { diff: PlanDiff; changed: Record<string, Task> } {
  const diff: PlanDiff = { added: [], updated: [], canceled: [], rewired: [] };
  const changed: Record<string, Task> = {};
  const ids = [...after.keys()].sort(compareTaskIds);
  for (const id of ids) {
    const task = after.get(id)!;
    const previous = before[id];
    if (previous === task) continue;
    changed[id] = task;
    if (!previous) {
      diff.added.push(toTaskPreview(task));
      continue;
    }
    if (task.status === "canceled" && previous.status !== "canceled") {
      diff.canceled.push(id);
      continue;
    }
    const dependsChanged =
      previous.dependsOn.length !== task.dependsOn.length || previous.dependsOn.some((dep, i) => task.dependsOn[i] !== dep);
    if (dependsChanged) diff.rewired.push({ taskId: id, dependsOn: task.dependsOn });
    const criteriaChanged = previous.acceptanceCriteria.join(" ") !== task.acceptanceCriteria.join(" ");
    if (criteriaChanged || PREVIEW_KEYS.some((key) => previous[key] !== task[key])) {
      const preview: TaskPreview = toTaskPreview(task);
      diff.updated.push(preview);
    }
  }
  return { diff, changed };
}

const describeTarget = (op: PlanOp): string => ("taskId" in op ? ` ${op.taskId}` : op.op === "add_task" && op.ref ? ` ${op.ref}` : "");

/**
 * Applies plan operations to the task ledger. Pure: returns a new ledger and never mutates `base`.
 * - `atomic`: all-or-nothing (planner, replanner, human edits).
 * - `per-op`: invalid ops are rejected individually (policy, proposals).
 */
export function applyPlanOps(base: TaskMap, ops: readonly PlanOp[], ctx: ApplyContext, mode: ApplyMode): ApplyResult {
  let draft = Draft.from(base, ctx);
  const applied: AppliedOp[] = [];
  const rejected: RejectedOp[] = [];
  const errors: string[] = [];

  ops.forEach((op, index) => {
    if (index >= ctx.guards.maxOpsPerPatch) {
      const message = `too many operations in one patch (max ${ctx.guards.maxOpsPerPatch})`;
      rejected.push({ index, op, errors: [message], duplicateOf: null });
      errors.push(`op ${index + 1} (${op.op}${describeTarget(op)}): ${message}`);
      return;
    }
    const candidate = draft.clone();
    const outcome = applyOne(candidate, op, ctx);
    if (outcome.errors.length === 0) {
      const cycle = findCycle(candidate.record());
      if (cycle) outcome.errors.push(`would create a dependency cycle involving ${cycle.join(", ")}`);
    }
    if (outcome.errors.length > 0) {
      rejected.push({ index, op, errors: outcome.errors, duplicateOf: outcome.duplicateOf });
      for (const error of outcome.errors) errors.push(`op ${index + 1} (${op.op}${describeTarget(op)}): ${error}`);
      return;
    }
    draft = candidate;
    applied.push({ index, op, taskIds: outcome.taskIds });
  });

  if (mode === "atomic" && rejected.length > 0) {
    return {
      ok: false,
      tasks: { ...base },
      changed: {},
      refs: {},
      applied: [],
      rejected,
      diff: { added: [], updated: [], canceled: [], rewired: [] },
      planVersion: ctx.planVersion,
      taskSeq: ctx.taskSeq,
      spentFingerprints: [...ctx.spentFingerprints],
      errors,
    };
  }

  const { diff, changed } = computeDiff(base, draft.tasks);
  const anyChange = Object.keys(changed).length > 0;
  return {
    ok: true,
    tasks: draft.record(),
    changed,
    refs: Object.fromEntries(draft.refs),
    applied,
    rejected,
    diff,
    planVersion: anyChange ? ctx.planVersion + 1 : ctx.planVersion,
    taskSeq: draft.taskSeq,
    spentFingerprints: [...draft.spent],
    errors,
  };
}
