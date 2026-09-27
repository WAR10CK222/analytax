import { z } from "zod";
import { Complexity, Tier } from "./common.js";
import { DependencyPolicy, MACHINE_CHECK_KINDS, NewTask, TaskOriginKind } from "./task.js";

export const OpSourceKind = z.enum(["planner", "replanner", "proposal", "policy", "human"]);
export type OpSourceKind = z.infer<typeof OpSourceKind>;

export const OpSource = z.object({
  kind: OpSourceKind,
  taskId: z.string().nullable().default(null),
});
export type OpSource = z.infer<typeof OpSource>;

const opBase = {
  reason: z.string().default(""),
  source: OpSource,
};

export const SplitSubtask = NewTask.extend({
  ref: z.string().min(1),
});
export type SplitSubtask = z.infer<typeof SplitSubtask>;

/** Every plan mutation. Applied only by `applyPlanOps` after validation. */
export const PlanOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_task"),
    ...opBase,
    /** Lets later ops in the same batch reference this task before it has an id. */
    ref: z.string().nullable().default(null),
    task: NewTask,
    /** Overrides the origin derived from `source` (e.g. `direct`, `fallback`). */
    originKind: TaskOriginKind.nullable().default(null),
  }),
  z.object({
    op: z.literal("update_task"),
    ...opBase,
    taskId: z.string(),
    patch: z.object({
      title: z.string().min(1).optional(),
      instructions: z.string().min(1).optional(),
      acceptanceCriteria: z.array(z.string().min(1)).min(1).optional(),
      agentId: z.string().min(1).optional(),
      capability: z.string().min(1).optional(),
      tierOverride: Tier.nullable().optional(),
      critical: z.boolean().optional(),
      dependencyPolicy: DependencyPolicy.optional(),
      feedback: z.string().optional(),
    }),
  }),
  z.object({
    op: z.literal("cancel_task"),
    ...opBase,
    taskId: z.string(),
    cascade: z.enum(["auto", "drop_dependency"]).default("auto"),
  }),
  z.object({
    op: z.literal("add_dependency"),
    ...opBase,
    taskId: z.string(),
    dependsOn: z.string(),
  }),
  z.object({
    op: z.literal("remove_dependency"),
    ...opBase,
    taskId: z.string(),
    dependsOn: z.string(),
  }),
  z.object({
    op: z.literal("split_task"),
    ...opBase,
    taskId: z.string(),
    /** `dependsOn` may reference sibling refs or existing task ids. */
    subtasks: z.array(SplitSubtask).min(2),
    /** Refs whose completion satisfies T's dependents. Defaults to subtasks nobody else depends on. */
    sinks: z.array(z.string()).default([]),
  }),
  z.object({
    op: z.literal("revise_task"),
    ...opBase,
    taskId: z.string(),
    instructions: z.string().min(1),
    waitFor: z.array(z.string()).default([]),
  }),
  z.object({
    op: z.literal("retry_task"),
    ...opBase,
    taskId: z.string(),
    resetAttempts: z.boolean().default(true),
    instructions: z.string().nullable().default(null),
    agentId: z.string().nullable().default(null),
  }),
]);
export type PlanOp = z.infer<typeof PlanOp>;
export type PlanOpInput = z.input<typeof PlanOp>;
export type PlanOpType = PlanOp["op"];
export const PLAN_OP_TYPES = [
  "add_task",
  "update_task",
  "cancel_task",
  "add_dependency",
  "remove_dependency",
  "split_task",
  "revise_task",
  "retry_task",
] as const satisfies readonly PlanOpType[];

// ---------------------------------------------------------------------------------------------------------------
// LLM-facing (flat) schemas for the planner and replanner
// ---------------------------------------------------------------------------------------------------------------

export const PlanTaskWire = z.object({
  ref: z.string().describe("Short unique reference for this task within the response, e.g. 'r1'"),
  title: z.string().describe("Imperative title, max ~8 words"),
  instructions: z
    .string()
    .describe("Self-contained instructions: what to do, scope, and what the output must contain"),
  acceptanceCriteria: z.array(z.string()).describe("2-5 objectively checkable criteria"),
  checks: z
    .array(
      z.object({
        kind: z.enum(MACHINE_CHECK_KINDS),
        value: z.string().describe("Number for min/max checks, text for contains, '|'-separated headings for sections"),
      }),
    )
    .describe("Optional machine-checkable constraints (may be empty)"),
  capability: z.string().describe("The capability this task needs (must be offered by the chosen agent)"),
  agentId: z.string().describe("Id of the agent from the directory that is best suited"),
  complexity: Complexity,
  dependsOn: z
    .array(z.string())
    .describe("Refs (or existing task ids) that must complete before this task can start"),
  contextFrom: z
    .array(z.string())
    .describe("Extra refs/ids whose results should be given as context (besides dependencies)"),
  critical: z.boolean().describe("True if the final answer is not possible without this task"),
  dependencyPolicy: DependencyPolicy.describe(
    "all = never run if a dependency failed; best_effort = run anyway with whatever succeeded",
  ),
});
export type PlanTaskWire = z.infer<typeof PlanTaskWire>;

export const PlanDraftWire = z.object({
  rationale: z.string().describe("2-3 sentences: how the plan answers the client's goal"),
  synthesisGuidance: z.string().describe("How the final answer should be assembled from task results"),
  tasks: z.array(PlanTaskWire).describe("The task DAG; keep it as small as the goal allows"),
});
export type PlanDraftWire = z.infer<typeof PlanDraftWire>;

export const PlanOpWire = z.object({
  op: z.enum(PLAN_OP_TYPES),
  reason: z.string(),
  taskId: z.string().describe("Existing target task id (e.g. 't3'); empty for add_task"),
  dependsOn: z.string().describe("For add_dependency/remove_dependency: the prerequisite id or ref; else empty"),
  tasks: z
    .array(PlanTaskWire)
    .describe("add_task: exactly one new task; split_task: two or more subtasks; otherwise empty"),
  instructions: z.string().describe("update_task/revise_task/retry_task: replacement instructions; else empty"),
  agentId: z.string().describe("update_task/retry_task: reassign to this agent id; else empty"),
  waitFor: z.array(z.string()).describe("revise_task: ids/refs to wait for before revising; else empty"),
});
export type PlanOpWire = z.infer<typeof PlanOpWire>;

export const PlanPatchWire = z.object({
  diagnosis: z.string().describe("What went wrong or what changed, and how the patch addresses it"),
  ops: z.array(PlanOpWire).describe("At most 12 operations, applied in order"),
  giveUp: z
    .boolean()
    .describe("True only if no reasonable patch can make progress; stuck tasks will be canceled/failed"),
});
export type PlanPatchWire = z.infer<typeof PlanPatchWire>;
