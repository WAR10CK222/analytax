import {
  MACHINE_CHECK_KINDS,
  type MachineCheck,
  type NewTask,
  type OpSource,
  type PlanDraftWire,
  type PlanOp,
  type PlanPatchWire,
  type PlanTaskWire,
} from "@analytax/contracts";

const nonEmpty = (items: readonly string[]): string[] => items.map((item) => item.trim()).filter(Boolean);

export function wireTaskToNewTask(task: PlanTaskWire): NewTask {
  const checks: MachineCheck[] = task.checks
    .filter((check) => (MACHINE_CHECK_KINDS as readonly string[]).includes(check.kind) && check.value.trim())
    .map((check) => ({ kind: check.kind, value: check.value.trim() }));
  return {
    title: task.title.trim(),
    instructions: task.instructions.trim(),
    acceptanceCriteria: nonEmpty(task.acceptanceCriteria),
    checks,
    capability: task.capability.trim(),
    agentId: task.agentId.trim(),
    complexity: task.complexity,
    tierOverride: null,
    dependsOn: nonEmpty(task.dependsOn),
    dependencyPolicy: task.dependencyPolicy,
    contextFrom: nonEmpty(task.contextFrom),
    critical: task.critical,
    evaluation: "auto",
  };
}

function validateTask(task: PlanTaskWire, label: string): string[] {
  const errors: string[] = [];
  if (!task.ref.trim()) errors.push(`${label}: missing ref`);
  if (!task.title.trim()) errors.push(`${label}: missing title`);
  if (!task.instructions.trim()) errors.push(`${label}: missing instructions`);
  if (nonEmpty(task.acceptanceCriteria).length === 0) errors.push(`${label}: needs at least one acceptance criterion`);
  if (!task.agentId.trim()) errors.push(`${label}: missing agentId`);
  if (!task.capability.trim()) errors.push(`${label}: missing capability`);
  return errors;
}

/** Orders plan tasks so every dependency ref is created before it is referenced. */
function orderByRefs(tasks: readonly PlanTaskWire[]): { ordered: PlanTaskWire[]; errors: string[] } {
  const byRef = new Map(tasks.map((task) => [task.ref.trim(), task]));
  const ordered: PlanTaskWire[] = [];
  const state = new Map<string, "visiting" | "done">();
  const errors: string[] = [];
  const visit = (task: PlanTaskWire, trail: string[]): void => {
    const ref = task.ref.trim();
    if (state.get(ref) === "done") return;
    if (state.get(ref) === "visiting") {
      errors.push(`dependency cycle: ${[...trail, ref].join(" → ")}`);
      return;
    }
    state.set(ref, "visiting");
    for (const dependency of [...task.dependsOn, ...task.contextFrom].map((id) => id.trim())) {
      const target = byRef.get(dependency);
      if (target) visit(target, [...trail, ref]);
    }
    state.set(ref, "done");
    ordered.push(task);
  };
  for (const task of tasks) visit(task, []);
  return { ordered, errors };
}

export function planDraftToOps(draft: PlanDraftWire, maxTasks: number): { ops: PlanOp[]; errors: string[] } {
  const errors: string[] = [];
  if (draft.tasks.length === 0) errors.push("the plan has no tasks");
  if (draft.tasks.length > maxTasks) errors.push(`the plan has ${draft.tasks.length} tasks; the maximum is ${maxTasks}`);
  const refs = new Set<string>();
  draft.tasks.forEach((task, index) => {
    const label = `task ${index + 1} (${task.ref || "no ref"})`;
    errors.push(...validateTask(task, label));
    if (refs.has(task.ref.trim())) errors.push(`${label}: duplicate ref '${task.ref}'`);
    refs.add(task.ref.trim());
    for (const dependency of nonEmpty([...task.dependsOn, ...task.contextFrom])) {
      if (!draft.tasks.some((other) => other.ref.trim() === dependency)) errors.push(`${label}: references unknown ref '${dependency}'`);
    }
  });
  const { ordered, errors: cycleErrors } = orderByRefs(draft.tasks);
  errors.push(...cycleErrors);
  if (errors.length > 0) return { ops: [], errors };
  const source: OpSource = { kind: "planner", taskId: null };
  return {
    ops: ordered.map((task) => ({ op: "add_task", ref: task.ref.trim(), originKind: null, task: wireTaskToNewTask(task), reason: "initial plan", source })),
    errors: [],
  };
}

export function planPatchToOps(patch: PlanPatchWire, source: OpSource): { ops: PlanOp[]; errors: string[] } {
  const ops: PlanOp[] = [];
  const errors: string[] = [];
  patch.ops.forEach((wire, index) => {
    const label = `op ${index + 1} (${wire.op})`;
    const base = { reason: wire.reason.trim() || "replan", source };
    const taskId = wire.taskId.trim();
    const needTarget = () => {
      if (!taskId) errors.push(`${label}: taskId is required`);
      return Boolean(taskId);
    };
    switch (wire.op) {
      case "add_task": {
        const task = wire.tasks[0];
        if (!task || wire.tasks.length !== 1) {
          errors.push(`${label}: provide exactly one task in 'tasks'`);
          return;
        }
        const taskErrors = validateTask(task, label);
        if (taskErrors.length) {
          errors.push(...taskErrors);
          return;
        }
        ops.push({ op: "add_task", ...base, ref: task.ref.trim(), originKind: null, task: wireTaskToNewTask(task) });
        return;
      }
      case "update_task": {
        if (!needTarget()) return;
        const patchFields: Extract<PlanOp, { op: "update_task" }>["patch"] = {};
        if (wire.instructions.trim()) patchFields.instructions = wire.instructions.trim();
        if (wire.agentId.trim()) patchFields.agentId = wire.agentId.trim();
        if (Object.keys(patchFields).length === 0) {
          errors.push(`${label}: provide new instructions and/or agentId`);
          return;
        }
        ops.push({ op: "update_task", ...base, taskId, patch: patchFields });
        return;
      }
      case "cancel_task":
        if (needTarget()) ops.push({ op: "cancel_task", ...base, taskId, cascade: "auto" });
        return;
      case "add_dependency":
      case "remove_dependency":
        if (!needTarget()) return;
        if (!wire.dependsOn.trim()) {
          errors.push(`${label}: dependsOn is required`);
          return;
        }
        ops.push({ op: wire.op, ...base, taskId, dependsOn: wire.dependsOn.trim() });
        return;
      case "split_task": {
        if (!needTarget()) return;
        if (wire.tasks.length < 2) {
          errors.push(`${label}: provide at least two subtasks in 'tasks'`);
          return;
        }
        const subtaskErrors = wire.tasks.flatMap((task, i) => validateTask(task, `${label} subtask ${i + 1}`));
        if (subtaskErrors.length) {
          errors.push(...subtaskErrors);
          return;
        }
        ops.push({
          op: "split_task",
          ...base,
          taskId,
          subtasks: wire.tasks.map((task) => ({ ...wireTaskToNewTask(task), ref: task.ref.trim() })),
          sinks: [],
        });
        return;
      }
      case "revise_task":
        if (!needTarget()) return;
        if (!wire.instructions.trim()) {
          errors.push(`${label}: instructions are required`);
          return;
        }
        ops.push({ op: "revise_task", ...base, taskId, instructions: wire.instructions.trim(), waitFor: nonEmpty(wire.waitFor) });
        return;
      case "retry_task":
        if (!needTarget()) return;
        ops.push({
          op: "retry_task",
          ...base,
          taskId,
          resetAttempts: true,
          instructions: wire.instructions.trim() || null,
          agentId: wire.agentId.trim() || null,
        });
        return;
    }
  });
  return { ops, errors };
}
