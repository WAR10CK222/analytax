import {
  IntentAnalysis,
  PlanDraftWire,
  PlanPatchWire,
  SynthesisWire,
  type ReplanRequest,
  type RunInput,
  type Source,
  type Task,
  type TaskResult,
} from "@analytax/contracts";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { sortedTasks, type TaskMap } from "../planning/dag.js";
import type { StructuredInvoker, StructuredResult } from "../models/structured.js";
import { truncate } from "../util/text.js";

type CallOptions = { callbacks?: Callbacks; signal?: AbortSignal };

const clarificationsBlock = (clarifications: RunInput["clarifications"]): string =>
  clarifications.length
    ? `<clarifications>\n${clarifications.map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`).join("\n\n")}\n</clarifications>`
    : "";

// ----------------------------------------------------------------------------------------------------------------
// Intake
// ----------------------------------------------------------------------------------------------------------------

export const intakeSystem = (capabilities: readonly string[]): string => `You are the intake analyst of Analytax, a multi-agent orchestration system whose specialist agents offer these capabilities: ${capabilities.join(", ")}.

Analyze the client's query:
- goal: the underlying objective in one sentence.
- deliverable: what the client expects back (format, audience, length).
- complexity: trivial = one quick fact; low = a single focused task; medium = a few distinct steps; high = multi-step research, analysis and writing.
- path: "direct" when ONE agent working on ONE task can fully answer (factual questions, explanations, small calculations, short rewrites); "plan" when distinct steps with different capabilities are needed (e.g. research → analysis → writing, or comparisons across several items).
- suggestedCapability: for the direct path, the single best capability from the list above.
- ambiguity: isAmbiguous only if a useful answer is impossible without clarification — otherwise proceed on reasonable assumptions. At most 3 short questions. If clarifications were already answered, do not ask again.`;

export function analyzeIntent(
  invoker: StructuredInvoker,
  args: { query: string; clarifications: RunInput["clarifications"]; capabilities: readonly string[]; today: string } & CallOptions,
): Promise<StructuredResult<IntentAnalysis>> {
  const user = [`<today>${args.today}</today>`, `<query>\n${args.query}\n</query>`, clarificationsBlock(args.clarifications)]
    .filter(Boolean)
    .join("\n");
  return invoker.invoke({
    role: "intake",
    name: "submit_intent",
    schema: IntentAnalysis,
    system: intakeSystem(args.capabilities),
    user,
    callbacks: args.callbacks,
    signal: args.signal,
  });
}

// ----------------------------------------------------------------------------------------------------------------
// Planner
// ----------------------------------------------------------------------------------------------------------------

export const PLANNER_SYSTEM = `You are the planner of Analytax, a multi-agent orchestrator. Decompose the client's request into a small DAG of tasks, each assigned to exactly one pre-defined agent from the directory.

Principles
- One task = one agent and one clear deliverable. Instructions must be self-contained: the agent sees only its task, the results of the tasks it depends on, and a short plan outline.
- Use the fewest tasks that fully answer the request (effort scaling: low complexity → 1-2 tasks, medium → 3-5, high → 5-8). Never exceed the maximum.
- Run independent work in parallel: add a dependency ONLY when a task needs another task's output.
- Assign each task to the best-fitting agent; the task's capability must be one that agent lists.
- The orchestrator writes the final answer to the client from the task results. Add a writer task only when the deliverable needs substantial composition (report, brief, long-form). Add a critic review only for high-stakes or long deliverables, and make it depend on the task it reviews.
- Acceptance criteria: 2-5 objectively checkable statements specific to the task. Use machine checks only when precise (e.g. minSources for research).
- critical=true for tasks the final answer cannot do without. dependencyPolicy "best_effort" when a task can still add value if an input fails.
- Refs are local to this plan (r1, r2, ...); dependsOn and contextFrom reference refs.`;

export function draftPlan(
  invoker: StructuredInvoker,
  args: {
    query: string;
    intent: IntentAnalysis;
    clarifications: RunInput["clarifications"];
    directory: string;
    maxTasks: number;
    feedback: string | null;
    previous: PlanDraftWire | null;
    errors: readonly string[];
  } & CallOptions,
): Promise<StructuredResult<PlanDraftWire>> {
  const sections = [
    `<client_request>\n${args.query}\n</client_request>`,
    `<intent>\n${JSON.stringify(args.intent, null, 2)}\n</intent>`,
    clarificationsBlock(args.clarifications),
    `<agent_directory>\n${args.directory}\n</agent_directory>`,
    `<limits>Maximum tasks: ${args.maxTasks}</limits>`,
  ];
  if (args.feedback) sections.push(`<reviewer_feedback>\nThe reviewer rejected the previous plan. Address this feedback:\n${args.feedback}\n</reviewer_feedback>`);
  if (args.errors.length > 0) {
    sections.push(
      `<validation_errors>\nYour previous plan was invalid. Fix every error and return the complete corrected plan:\n${args.errors.map((error) => `- ${error}`).join("\n")}\n</validation_errors>`,
    );
    if (args.previous) sections.push(`<previous_plan>\n${JSON.stringify(args.previous)}\n</previous_plan>`);
  }
  return invoker.invoke({
    role: "planner",
    name: "submit_plan",
    schema: PlanDraftWire,
    system: PLANNER_SYSTEM,
    user: sections.filter(Boolean).join("\n\n"),
    callbacks: args.callbacks,
    signal: args.signal,
  });
}

// ----------------------------------------------------------------------------------------------------------------
// Replanner
// ----------------------------------------------------------------------------------------------------------------

export const REPLANNER_SYSTEM = `You are the replanner of Analytax. A plan is already executing and something unexpected happened: a task exhausted its recovery ladder, an agent discovered missing work, the plan is deadlocked, or progress stalled. Produce the SMALLEST patch that lets the run make progress toward the client's goal.

Operations
- retry_task(taskId, instructions?, agentId?): retry a failed/canceled/rejected task with improved instructions and/or another capable agent. Never retry with identical instructions and agent.
- split_task(taskId, tasks[2+]): replace a pending or failed task with smaller subtasks (subtask dependsOn may reference sibling refs or existing task ids).
- add_task(tasks[1]) and add_dependency(taskId, dependsOn=<ref or id>): insert missing prerequisite work before a pending task.
- update_task(taskId, instructions?, agentId?): fix a pending task.
- remove_dependency(taskId, dependsOn): let a pending task proceed without a failed input (update its instructions to say what is missing).
- cancel_task(taskId): drop work that is no longer needed or feasible.
- revise_task(taskId, instructions, waitFor): redo a COMPLETED task once new inputs exist.

Rules
- Existing task ids look like "t3"; new tasks use refs ("r1", ...). Never create a task identical to an existing one.
- Agents and capabilities must come from the directory. Respect the remaining limits.
- Set giveUp=true only if no reasonable patch can make progress; stuck tasks will then be canceled or failed.`;

export function renderDetailedOutline(tasks: TaskMap, results: Readonly<Record<string, TaskResult>>): string {
  return sortedTasks(tasks)
    .filter((task) => !(task.status === "canceled" && (task.supersededBy.length > 0 || task.statusReason === "plan_rejected")))
    .map((task: Task) => {
      const lines = [
        `- ${task.id} [${task.status}] "${task.title}" agent=${task.agentId} capability=${task.capability} complexity=${task.complexity} critical=${task.critical} attempts=${task.attempt} deps=[${task.dependsOn.join(", ")}] policy=${task.dependencyPolicy}`,
      ];
      if (task.statusReason) lines.push(`  status reason: ${truncate(task.statusReason, 200)}`);
      const last = task.history.at(-1);
      if (last) lines.push(`  last attempt: ${last.decision} by ${last.agentId}@${last.tier}${last.feedback ? ` — ${truncate(last.feedback.replace(/\s+/g, " "), 300)}` : ""}`);
      const result = results[task.id];
      if (result) lines.push(`  result summary: ${truncate(result.summary, 300)}`);
      return lines.join("\n");
    })
    .join("\n");
}

export function proposePatch(
  invoker: StructuredInvoker,
  args: {
    query: string;
    goal: string;
    outline: string;
    requests: readonly ReplanRequest[];
    directory: string;
    tasksRemaining: number;
    replansRemaining: number;
    previous: PlanPatchWire | null;
    errors: readonly string[];
  } & CallOptions,
): Promise<StructuredResult<PlanPatchWire>> {
  const requests = args.requests
    .map((request) => `<request id="${request.id}" trigger="${request.trigger}"${request.taskId ? ` task="${request.taskId}"` : ""}>\n${request.detail}${request.dossier ? `\n<dossier>\n${request.dossier}\n</dossier>` : ""}\n</request>`)
    .join("\n");
  const sections = [
    `<client_request>\n${args.query}\n</client_request>`,
    `<goal>${args.goal}</goal>`,
    `<plan_state>\n${args.outline}\n</plan_state>`,
    `<replan_requests>\n${requests}\n</replan_requests>`,
    `<agent_directory>\n${args.directory}\n</agent_directory>`,
    `<limits>New tasks allowed: ${args.tasksRemaining}. Replans remaining after this one: ${Math.max(0, args.replansRemaining - 1)}.</limits>`,
  ];
  if (args.errors.length > 0) {
    sections.push(`<validation_errors>\nYour previous patch was rejected. Fix every error and return a complete corrected patch:\n${args.errors.map((error) => `- ${error}`).join("\n")}\n</validation_errors>`);
    if (args.previous) sections.push(`<previous_patch>\n${JSON.stringify(args.previous)}\n</previous_patch>`);
  }
  return invoker.invoke({
    role: "replanner",
    name: "submit_plan_patch",
    schema: PlanPatchWire,
    system: REPLANNER_SYSTEM,
    user: sections.join("\n\n"),
    callbacks: args.callbacks,
    signal: args.signal,
  });
}

// ----------------------------------------------------------------------------------------------------------------
// Synthesizer
// ----------------------------------------------------------------------------------------------------------------

export const SYNTHESIZER_SYSTEM = `You write the final answer for the client of Analytax, a multi-agent research and analysis system.

- Answer the client's request directly in the first sentence or two, then give only the supporting detail that matters.
- Use ONLY information in the task results provided. Never invent facts, numbers or sources.
- Match the requested deliverable (format, audience, length). Prefer tight structure: short paragraphs, bullets, and tables for comparisons.
- Cite sources inline as [n] using the numbered source list provided (renumber citations found in task outputs to match that list).
- Never mention tasks, agents, the orchestration process, internal ids or model tiers.
- limitations: only material gaps the client must know about (from <gaps> or conflicting results); empty otherwise.`;

export type SynthesisEntry = {
  title: string;
  summary: string;
  keyFindings: string[];
  output: string | null;
  degraded: boolean;
  stale: boolean;
};

export function synthesizeAnswer(
  invoker: StructuredInvoker,
  args: {
    query: string;
    intent: IntentAnalysis | null;
    guidance: string;
    entries: readonly SynthesisEntry[];
    sources: readonly Source[];
    gaps: readonly { title: string; reason: string }[];
    assumptions: readonly string[];
    clarifications: RunInput["clarifications"];
  } & CallOptions,
): Promise<StructuredResult<SynthesisWire>> {
  const results = args.entries
    .map((entry, index) => {
      const flags = [entry.degraded ? "degraded (did not fully pass review)" : "", entry.stale ? "may predate later revisions" : ""].filter(Boolean);
      return [
        `<result n="${index + 1}" title="${entry.title}"${flags.length ? ` note="${flags.join("; ")}"` : ""}>`,
        `<summary>${entry.summary}</summary>`,
        entry.keyFindings.length ? `<key_findings>\n${entry.keyFindings.map((finding) => `- ${finding}`).join("\n")}\n</key_findings>` : "",
        entry.output ? `<content>\n${entry.output}\n</content>` : "",
        "</result>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
  const sections = [
    `<client_request>\n${args.query}\n</client_request>`,
    args.intent ? `<deliverable format="${args.intent.deliverable.format}" audience="${args.intent.deliverable.audience}" length="${args.intent.deliverable.length}" />` : "",
    clarificationsBlock(args.clarifications),
    args.guidance ? `<synthesis_guidance>${args.guidance}</synthesis_guidance>` : "",
    `<task_results>\n${results || "(no results)"}\n</task_results>`,
    `<sources>\n${args.sources.map((source, index) => `[${index + 1}] ${source.title}${source.url ? ` — ${source.url}` : ""}`).join("\n") || "(none)"}\n</sources>`,
    args.gaps.length ? `<gaps>\n${args.gaps.map((gap) => `- ${gap.title}: ${gap.reason}`).join("\n")}\n</gaps>` : "",
    args.assumptions.length ? `<assumptions>\n${args.assumptions.map((assumption) => `- ${assumption}`).join("\n")}\n</assumptions>` : "",
  ];
  return invoker.invoke({
    role: "synthesizer",
    name: "submit_final_answer",
    schema: SynthesisWire,
    system: SYNTHESIZER_SYSTEM,
    user: sections.filter(Boolean).join("\n\n"),
    callbacks: args.callbacks,
    signal: args.signal,
  });
}
