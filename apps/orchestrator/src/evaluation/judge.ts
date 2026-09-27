import {
  VerdictWire,
  verdictFromWire,
  type CheckResult,
  type Task,
  type TaskOutcome,
  type Tier,
  type Usage,
  type Verdict,
} from "@analytax/contracts";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { summarizeSources, type ContextPacket } from "../control/context-packet.js";
import type { StructuredInvoker } from "../models/structured.js";
import { truncate } from "../util/text.js";
import { blockingFailures } from "./checks.js";

export const JUDGE_SYSTEM = `You are a strict but fair quality reviewer in a multi-agent system. You evaluate ONE task result against its acceptance criteria.

Rules:
- Judge only what this task asked for; do not demand work that belongs to other tasks in the plan.
- A criterion is met only if the output clearly satisfies it. Give one sentence of evidence per criterion.
- Check important claims against the upstream context and cited sources; flag unsupported, outdated or contradictory claims as issues.
- decision: "accept" only if every criterion is met and there is no blocker issue; "revise" if specific feedback can fix it; "reject" if it is fundamentally wrong or off-task.
- feedback: concrete, actionable instructions for the next attempt (empty when accepting).
- missingPrerequisite: if the task cannot succeed until some other work is done first, describe that work; otherwise empty.`;

export type JudgeResult = { verdict: Verdict; usage: Usage; model: string };

export async function judgeOutcome(args: {
  invoker: StructuredInvoker;
  task: Task;
  outcome: TaskOutcome;
  packet: ContextPacket;
  tier: Tier;
  maxOutputChars: number;
  callbacks?: Callbacks;
  signal?: AbortSignal;
}): Promise<JudgeResult> {
  const { task, outcome, packet } = args;
  const upstream = packet.upstream
    .slice(0, 6)
    .map((entry) => `<upstream_summary task="${entry.taskId}" title="${entry.title}">${truncate(entry.summary, 800)}</upstream_summary>`)
    .join("\n");
  const user = [
    `<task id="${task.id}" capability="${task.capability}">`,
    `<title>${task.title}</title>`,
    `<instructions>\n${task.instructions}\n</instructions>`,
    `<acceptance_criteria>\n${task.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n")}\n</acceptance_criteria>`,
    "</task>",
    `<client_goal>${packet.goal}</client_goal>`,
    upstream,
    `<result status="${outcome.status}" self_reported_confidence="${outcome.confidence.toFixed(2)}">`,
    `<summary>${outcome.summary}</summary>`,
    `<output>\n${truncate(outcome.output, args.maxOutputChars)}\n</output>`,
    `<sources>\n${summarizeSources(outcome.sources, 12) || "(none)"}\n</sources>`,
    outcome.assumptions.length ? `<assumptions>${outcome.assumptions.join("; ")}</assumptions>` : "",
    "</result>",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await args.invoker.invoke({
    role: "judge",
    tier: args.tier,
    name: "submit_verdict",
    schema: VerdictWire,
    system: JUDGE_SYSTEM,
    user,
    callbacks: args.callbacks,
    signal: args.signal,
    metadata: { analytax_task_id: task.id },
  });
  return { verdict: verdictFromWire(result.value), usage: result.usage, model: result.model };
}

/** The judge never shares the worker's model instance: same tier → one tier stronger; deep workers → standard. */
export function judgeTier(workerTier: Tier, roleTier: Tier): Tier {
  if (workerTier === "deep") return "standard";
  if (workerTier !== roleTier) return roleTier;
  return roleTier === "standard" ? "fast-thinking" : "standard";
}

export function shouldSkipJudge(args: {
  task: Task;
  outcome: TaskOutcome;
  cardEvaluation: Task["evaluation"];
  attempt: number;
  isSink: boolean;
  skipConfidence: number;
}): boolean {
  const { task, outcome } = args;
  if (args.cardEvaluation === "never" || task.evaluation === "never") return true;
  if (task.evaluation === "always" || args.cardEvaluation === "always") return false;
  return (
    task.complexity === "low" &&
    outcome.status === "completed" &&
    outcome.confidence >= args.skipConfidence &&
    !task.critical &&
    args.attempt === 1 &&
    !args.isSink
  );
}

export const skippedVerdict = (task: Task, outcome: TaskOutcome): Verdict => ({
  decision: "accept",
  score: outcome.confidence,
  evaluatedBy: "skipped",
  criteria: task.acceptanceCriteria.map((criterion) => ({ criterion, met: true, note: "Not judged (low-risk task or agent reviews its own work)" })),
  issues: [],
  feedback: "",
  missingPrerequisite: null,
});

export function rulesVerdict(task: Task, checks: readonly CheckResult[], feedback?: string): Verdict {
  const failures = blockingFailures(checks);
  return {
    decision: "revise",
    score: 0.2,
    evaluatedBy: "rules",
    criteria: task.acceptanceCriteria.map((criterion) => ({ criterion, met: false, note: "Not judged: deterministic checks failed" })),
    issues: failures.map((failure) => ({ severity: "blocker" as const, text: failure.message })),
    feedback: feedback ?? `Fix these problems: ${failures.map((failure) => failure.message).join("; ")}`,
    missingPrerequisite: null,
  };
}

/** Used when the judge call itself fails: trust confident completed work, otherwise ask for a revision. */
export function fallbackVerdict(task: Task, outcome: TaskOutcome, error: string): Verdict {
  const accept = outcome.status === "completed" && outcome.confidence >= 0.6;
  return {
    decision: accept ? "accept" : "revise",
    score: outcome.confidence,
    evaluatedBy: "rules",
    criteria: task.acceptanceCriteria.map((criterion) => ({ criterion, met: accept, note: "Judge unavailable; based on self-reported confidence" })),
    issues: [{ severity: "minor", text: `Judge unavailable: ${truncate(error, 200)}` }],
    feedback: accept ? "" : "Confidence was low and the output could not be reviewed. Verify every acceptance criterion explicitly.",
    missingPrerequisite: null,
  };
}
