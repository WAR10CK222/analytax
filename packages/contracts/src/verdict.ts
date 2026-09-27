import { z } from "zod";

export const VerdictDecision = z.enum(["accept", "revise", "reject"]);
export type VerdictDecision = z.infer<typeof VerdictDecision>;

export const EvaluatedBy = z.enum(["rules", "llm", "skipped"]);
export type EvaluatedBy = z.infer<typeof EvaluatedBy>;

export const IssueSeverity = z.enum(["blocker", "major", "minor"]);
export type IssueSeverity = z.infer<typeof IssueSeverity>;

export const Verdict = z.object({
  decision: VerdictDecision,
  score: z.number().min(0).max(1),
  evaluatedBy: EvaluatedBy,
  criteria: z.array(z.object({ criterion: z.string(), met: z.boolean(), note: z.string() })),
  issues: z.array(z.object({ severity: IssueSeverity, text: z.string() })),
  feedback: z.string(),
  missingPrerequisite: z.string().nullable(),
});
export type Verdict = z.infer<typeof Verdict>;

/** LLM-judge response schema (flat). */
export const VerdictWire = z.object({
  criteria: z
    .array(
      z.object({
        criterion: z.string().describe("The acceptance criterion, verbatim"),
        met: z.boolean(),
        note: z.string().describe("One sentence of evidence"),
      }),
    )
    .describe("One entry per acceptance criterion, in order"),
  issues: z.array(z.object({ severity: IssueSeverity, text: z.string() })),
  decision: VerdictDecision.describe(
    "accept only if every criterion is met; revise if fixable with feedback; reject if fundamentally wrong",
  ),
  score: z.number().describe("0.0-1.0 overall quality"),
  feedback: z.string().describe("Concrete, actionable instructions for the next attempt (empty when accepting)"),
  missingPrerequisite: z
    .string()
    .describe("If the task cannot succeed without some other work being done first, describe it; else empty"),
});
export type VerdictWire = z.infer<typeof VerdictWire>;

export function verdictFromWire(wire: VerdictWire): Verdict {
  const unmet = wire.criteria.some((criterion) => !criterion.met);
  const blocker = wire.issues.some((issue) => issue.severity === "blocker");
  let decision = wire.decision;
  // "Accept" requires every criterion to be met and no blocker, regardless of what the judge said.
  if (decision === "accept" && (unmet || blocker)) decision = "revise";
  let score = Number.isFinite(wire.score) ? wire.score : 0;
  if (score > 1 && score <= 100) score /= 100;
  return {
    decision,
    score: Math.min(1, Math.max(0, score)),
    evaluatedBy: "llm",
    criteria: wire.criteria,
    issues: wire.issues.filter((issue) => issue.text.trim()),
    feedback: wire.feedback.trim(),
    missingPrerequisite: wire.missingPrerequisite.trim() || null,
  };
}
