import { z } from "zod";
import { HumanDecision, HumanRequest } from "./control.js";
import { PlanOp } from "./plan-ops.js";
import { TaskPreview } from "./task.js";

export const ClarifyInterrupt = z.object({
  kind: z.literal("clarify"),
  goal: z.string(),
  questions: z.array(z.string()),
});
export type ClarifyInterrupt = z.infer<typeof ClarifyInterrupt>;

export const ApprovePlanInterrupt = z.object({
  kind: z.literal("approve_plan"),
  version: z.number().int(),
  rationale: z.string(),
  tasks: z.array(TaskPreview),
  /** Validation errors from a previously submitted edit. */
  errors: z.array(z.string()),
});
export type ApprovePlanInterrupt = z.infer<typeof ApprovePlanInterrupt>;

export const HumanReviewInterrupt = z.object({
  kind: z.literal("human_review"),
  requests: z.array(HumanRequest),
});
export type HumanReviewInterrupt = z.infer<typeof HumanReviewInterrupt>;

export const HitlInterrupt = z.discriminatedUnion("kind", [ClarifyInterrupt, ApprovePlanInterrupt, HumanReviewInterrupt]);
export type HitlInterrupt = z.infer<typeof HitlInterrupt>;

export const ClarifyResume = z.object({
  /** Same order as the interrupt's questions. */
  answers: z.array(z.string()),
});
export type ClarifyResume = z.infer<typeof ClarifyResume>;

export const ApprovePlanResume = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve") }),
  z.object({ decision: z.literal("edit"), ops: z.array(PlanOp) }),
  z.object({ decision: z.literal("reject"), feedback: z.string().min(1) }),
]);
export type ApprovePlanResume = z.infer<typeof ApprovePlanResume>;
export type ApprovePlanResumeInput = z.input<typeof ApprovePlanResume>;

export const HumanReviewResume = z.object({
  decisions: z.array(
    z.object({
      requestId: z.string(),
      decision: HumanDecision,
      answer: z.string().optional(),
      instructions: z.string().optional(),
    }),
  ),
});
export type HumanReviewResume = z.infer<typeof HumanReviewResume>;
