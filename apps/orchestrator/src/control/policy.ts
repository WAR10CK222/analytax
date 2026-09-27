import {
  nextTier,
  type HitlSettings,
  type HumanRequestKind,
  type Proposal,
  type ReplanTrigger,
  type Task,
  type Tier,
  type WorkerReport,
} from "@analytax/contracts";
import type { AgentCard } from "../agents/registry.js";
import type { Guards } from "../config/schema.js";

export type PolicyInput = {
  task: Task;
  report: WorkerReport;
  card: AgentCard;
  /** Best capable agent that hasn't tried this task yet. */
  altAgentId: string | null;
  guards: Guards;
  degradedScore: number;
  hitl: HitlSettings;
  humanReviewsLeft: number;
  replansLeft: number;
  /** Budget, deadline or max-waves reached: accept what passes, fail the rest. */
  stopRequested: boolean;
  hasDependents: boolean;
  /** Times this task hit the same error signature (including this report). */
  errorRepeats: number;
  /** This attempt's output is identical to a previous attempt's. */
  outputRepeat: boolean;
};

export type PolicyAction =
  | { kind: "accept" }
  | { kind: "requeue"; reason: string }
  | { kind: "retry"; feedback: string; assume: boolean }
  | { kind: "escalate"; toTier: Tier; feedback: string }
  | { kind: "reassign"; toAgentId: string; feedback: string }
  | { kind: "block"; prerequisite: Proposal }
  | { kind: "input_required"; questions: string[] }
  | { kind: "replan"; trigger: ReplanTrigger; detail: string; guard?: "error_loop" | "block_loop" }
  | { kind: "human"; request: HumanRequestKind; question: string; guard?: "error_loop" | "block_loop" }
  | { kind: "fail"; reason: string; degraded: boolean; guard?: "error_loop" | "block_loop" }
  | { kind: "reject"; reason: string };

const ERROR_HINTS: Record<string, string> = {
  limit: "You exhausted your model/tool-call budget. Plan fewer, sharper tool calls and submit your outcome earlier.",
  schema: "Your final result did not match the required outcome schema. Call the outcome tool exactly once with every field filled.",
  timeout: "You ran out of time. Be more economical with tool calls and submit earlier.",
  tool: "A tool failed. Try a different approach or tool, or submit with what you have.",
};

/** Human-readable feedback for the next attempt, assembled from the verdict, failed checks and errors. */
export function feedbackFrom(report: WorkerReport): string {
  const parts: string[] = [];
  const { verdict, error } = report;
  if (error) parts.push(`The previous attempt failed (${error.kind}): ${error.message}. ${ERROR_HINTS[error.kind] ?? ""}`.trim());
  if (verdict?.feedback) parts.push(verdict.feedback);
  const unmet = verdict?.criteria.filter((criterion) => !criterion.met) ?? [];
  if (unmet.length) parts.push(`Unmet acceptance criteria:\n${unmet.map((criterion) => `- ${criterion.criterion}: ${criterion.note}`).join("\n")}`);
  const issues = verdict?.issues.filter((issue) => issue.severity !== "minor") ?? [];
  if (issues.length) parts.push(`Issues:\n${issues.map((issue) => `- [${issue.severity}] ${issue.text}`).join("\n")}`);
  const failedChecks = report.checks.filter((check) => !check.passed && check.severity !== "minor");
  if (failedChecks.length) parts.push(`Failed checks:\n${failedChecks.map((check) => `- ${check.message}`).join("\n")}`);
  if (report.outcome?.status === "blocked" && !report.outcome.proposals.some((proposal) => proposal.kind === "prerequisite")) {
    parts.push("You reported 'blocked' without a prerequisite proposal. Either complete the task or propose exactly what must be done first.");
  }
  return parts.join("\n\n") || "The previous attempt did not meet the acceptance criteria. Address every criterion explicitly.";
}

function exhausted(input: PolicyInput, guard?: "error_loop" | "block_loop"): PolicyAction {
  const { task, report } = input;
  const detail = `${task.id} "${task.title}" failed ${task.attempt} attempt(s): ${feedbackFrom(report).slice(0, 400)}`;
  if (input.replansLeft > 0 && (task.critical || input.hasDependents)) {
    return { kind: "replan", trigger: "ladder_exhausted", detail, guard };
  }
  if (input.hitl.humanReview && input.humanReviewsLeft > 0 && task.critical) {
    return { kind: "human", request: "task_failed", question: `How should "${task.title}" proceed after repeated failures?`, guard };
  }
  const score = report.verdict?.score ?? 0;
  const hasOutput = Boolean(report.outcome?.output.trim());
  return {
    kind: "fail",
    reason: guard === "error_loop" ? "repeated identical errors" : guard === "block_loop" ? "blocked repeatedly" : "recovery ladder exhausted",
    degraded: hasOutput && score >= input.degradedScore,
    guard,
  };
}

/** Deterministic recovery ladder (first match wins). */
export function decide(input: PolicyInput): PolicyAction {
  const { task, report, guards } = input;
  const { outcome, verdict, error } = report;
  const accepted = verdict?.decision === "accept" && (outcome?.status === "completed" || outcome?.status === "partial");

  // Row 1 — run is stopping: keep what passes, fail the rest.
  if (input.stopRequested) {
    if (accepted) return { kind: "accept" };
    const score = verdict?.score ?? 0;
    return { kind: "fail", reason: "run stopped (budget, deadline or wave limit)", degraded: Boolean(outcome?.output.trim()) && score >= input.degradedScore };
  }

  // Row 2/3 — errors: requeue transient ones, otherwise treat as a rejection.
  if (error) {
    if (error.transient && task.infraRetries < guards.maxInfraRetries) return { kind: "requeue", reason: `${error.kind}: ${error.message}` };
    if (input.errorRepeats >= 3) return exhausted(input, "error_loop");
    return ladder(input);
  }
  if (!outcome) return ladder(input);

  // Row 4 — declined: another capable agent, or reject.
  if (outcome.status === "declined") {
    if (input.altAgentId) {
      return { kind: "reassign", toAgentId: input.altAgentId, feedback: `Previous agent declined: ${outcome.summary}` };
    }
    return { kind: "reject", reason: `declined by ${task.agentId} and no other agent offers '${task.capability}'` };
  }

  // Row 5 — needs client input.
  if (outcome.status === "needs_input") {
    const questions = outcome.openQuestions.length
      ? outcome.openQuestions
      : outcome.proposals.filter((proposal) => proposal.kind === "clarification").map((proposal) => proposal.instructions);
    if (input.hitl.humanReview && input.humanReviewsLeft > 0) return { kind: "input_required", questions: questions.length ? questions : [outcome.summary] };
    if (!task.assumeOnRetry) {
      return {
        kind: "retry",
        assume: true,
        feedback: `Client input is not available. Proceed on explicit, reasonable assumptions (list them in 'assumptions'). Open questions were: ${questions.join("; ")}`,
      };
    }
    return exhausted(input);
  }

  // Row 6 — blocked on a newly discovered prerequisite.
  if (outcome.status === "blocked") {
    const prerequisite = outcome.proposals.find((proposal) => proposal.kind === "prerequisite");
    if (prerequisite && task.blockCount < guards.maxBlocks) return { kind: "block", prerequisite };
    if (prerequisite) return exhausted(input, "block_loop");
    return ladder(input);
  }

  // Row 7 — accepted by the judge (or judge skipped for a low-risk task).
  if (accepted) return { kind: "accept" };

  return ladder(input);
}

/** Rows 8–13: retry → escalate tier → reassign → replan → human → fail. */
function ladder(input: PolicyInput): PolicyAction {
  const { task, report, card, guards } = input;
  const feedback = feedbackFrom(report);
  const repeated = input.errorRepeats >= 2 || input.outputRepeat;
  if (task.attempt < guards.maxAttempts) {
    if (task.attempt < 2 && !repeated) return { kind: "retry", feedback, assume: false };
    const higher = nextTier(report.tier, card.model.maxTier);
    if (higher) return { kind: "escalate", toTier: higher, feedback };
    if (input.altAgentId) return { kind: "reassign", toAgentId: input.altAgentId, feedback };
  }
  return exhausted(input);
}
