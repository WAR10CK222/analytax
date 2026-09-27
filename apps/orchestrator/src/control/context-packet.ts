import type { ArtifactRef, IntentAnalysis, RunInput, Source, Task, TaskResult } from "@analytax/contracts";
import { ancestors, sortedTasks, topologicalSort, type TaskMap } from "../planning/dag.js";
import { estimateTokens, truncate, uniq } from "../util/text.js";

export type UpstreamEntry = {
  taskId: string;
  title: string;
  agentId: string;
  relation: "dependency" | "context" | "ancestor";
  /** full = output inline; reference = large output in the artifact store; summary = summary/findings only. */
  mode: "full" | "reference" | "summary";
  summary: string;
  keyFindings: string[];
  sources: Source[];
  output: string | null;
  artifactKey: string | null;
  degraded: boolean;
  outputChars: number;
};

export type ContextPacket = {
  query: string;
  goal: string;
  deliverable: IntentAnalysis["deliverable"] | null;
  constraints: string[];
  task: Pick<Task, "id" | "title" | "instructions" | "acceptanceCriteria" | "capability">;
  whyThisTask: string;
  upstream: UpstreamEntry[];
  planOutline: string;
  priorAttempts: { attempt: number; agentId: string; tier: string; decision: string; feedback: string; issues: string[] }[];
  pendingFeedback: string | null;
  assumeOnRetry: boolean;
  partialRef: ArtifactRef | null;
  notes: string[];
  clarifications: RunInput["clarifications"];
  staleInputs: boolean;
  /** artifact key → ref, for read_artifact and worker-side preloading. */
  artifacts: Record<string, ArtifactRef>;
  budget: { packetTokens: number; usedTokens: number };
};

export type PacketInputs = {
  tasks: TaskMap;
  results: Readonly<Record<string, TaskResult>>;
  intent: IntentAnalysis | null;
  input: RunInput | null;
};

export const artifactKeyOf = (ref: ArtifactRef): string => ref.key;

const OUTLINE_LIMIT = 15;

export function renderPlanOutline(tasks: TaskMap, focusId: string | null = null): string {
  const ordered = sortedTasks(tasks).filter((task) => !(task.status === "canceled" && task.supersededBy.length > 0));
  const lines = ordered.slice(0, OUTLINE_LIMIT).map((task) => {
    const deps = task.dependsOn.length ? ` (after ${task.dependsOn.join(", ")})` : "";
    const marker = task.id === focusId ? " ← this task" : "";
    return `- ${task.id} [${task.status}] ${task.title} — ${task.agentId}${deps}${marker}`;
  });
  if (ordered.length > OUTLINE_LIMIT) lines.push(`- … ${ordered.length - OUTLINE_LIMIT} more`);
  return lines.join("\n");
}

function whyThisTask(task: Task, tasks: TaskMap): string {
  const dependents = sortedTasks(tasks).filter((other) => other.dependsOn.includes(task.id) && other.status !== "canceled");
  const parts: string[] = [];
  if (task.origin.kind === "proposal" && task.origin.parentTaskId) parts.push(`Proposed by ${task.origin.parentTaskId} during execution.`);
  if (task.origin.kind === "split" && task.origin.parentTaskId) parts.push(`Part of a split of ${task.origin.parentTaskId}.`);
  if (task.revisionOf) parts.push(`Revision of ${task.revisionOf}: improve that result using the new inputs.`);
  if (dependents.length) parts.push(`Its result is used by: ${dependents.map((other) => `${other.id} (${other.title})`).join("; ")}.`);
  else parts.push("Its result feeds the final answer to the client.");
  if (task.critical) parts.push("The final answer depends on it.");
  return parts.join(" ");
}

function entryFor(result: TaskResult, task: Task | undefined, relation: UpstreamEntry["relation"]): UpstreamEntry {
  return {
    taskId: result.taskId,
    title: task?.title ?? result.taskId,
    agentId: result.agentId,
    relation,
    mode: "summary",
    summary: result.summary,
    keyFindings: result.keyFindings,
    sources: result.sources,
    output: null,
    artifactKey: result.outputRef ? artifactKeyOf(result.outputRef) : null,
    degraded: result.degraded,
    outputChars: result.outputChars,
  };
}

const entryTokens = (entry: UpstreamEntry): number =>
  estimateTokens(entry.summary) + estimateTokens(entry.keyFindings.join("\n")) + estimateTokens(entry.output ?? "") + 30;

/**
 * Builds a task-scoped context: must-haves, then direct inputs (summary → full text up to 60% of budget),
 * then transitive ancestors as summaries (up to 80%), then the plan outline. Pure function of state.
 */
export function buildContextPacket(task: Task, inputs: PacketInputs, packetTokens: number): ContextPacket {
  const { tasks, results, intent, input } = inputs;
  const priorAttempts = task.history.slice(-2).map((record) => ({
    attempt: record.attempt,
    agentId: record.agentId,
    tier: record.tier,
    decision: record.decision,
    feedback: record.feedback,
    issues: record.issues,
  }));

  const packet: ContextPacket = {
    query: input?.query ?? "",
    goal: intent?.goal ?? input?.query ?? "",
    deliverable: intent?.deliverable ?? null,
    constraints: intent?.constraints ?? [],
    task: {
      id: task.id,
      title: task.title,
      instructions: task.instructions,
      acceptanceCriteria: task.acceptanceCriteria,
      capability: task.capability,
    },
    whyThisTask: whyThisTask(task, tasks),
    upstream: [],
    planOutline: "",
    priorAttempts,
    pendingFeedback: task.pendingFeedback,
    assumeOnRetry: task.assumeOnRetry,
    partialRef: task.partialRef,
    notes: task.notes,
    clarifications: input?.clarifications ?? [],
    staleInputs: task.staleInputs,
    artifacts: {},
    budget: { packetTokens, usedTokens: 0 },
  };

  let used =
    estimateTokens(packet.query) +
    estimateTokens(task.instructions) +
    estimateTokens(task.acceptanceCriteria.join("\n")) +
    estimateTokens(packet.whyThisTask) +
    estimateTokens(JSON.stringify(priorAttempts)) +
    estimateTokens((task.pendingFeedback ?? "") + task.notes.join("\n")) +
    estimateTokens(JSON.stringify(packet.clarifications)) +
    200;

  // 1) Direct inputs: explicit context first, then dependencies (in plan order).
  const directIds = uniq([...task.contextFrom, ...task.dependsOn]);
  const entries: UpstreamEntry[] = [];
  for (const id of directIds) {
    const result = results[id];
    if (!result) continue;
    const entry = entryFor(result, tasks[id], task.dependsOn.includes(id) ? "dependency" : "context");
    entries.push(entry);
    used += entryTokens(entry);
  }

  // 2) Upgrade direct inputs to full text while under 60% of the budget.
  for (const entry of entries) {
    const result = results[entry.taskId];
    if (!result) continue;
    if (result.output !== null) {
      const cost = estimateTokens(result.output);
      if (used + cost <= packetTokens * 0.6) {
        entry.output = result.output;
        entry.mode = "full";
        used += cost;
      }
    } else if (result.outputRef) {
      entry.mode = "reference";
    }
    if (result.outputRef) packet.artifacts[artifactKeyOf(result.outputRef)] = result.outputRef;
  }

  // 3) Transitive ancestors as summaries while under 80%.
  const direct = new Set(directIds);
  const ancestorIds = new Set<string>();
  for (const id of directIds) for (const ancestor of ancestors(tasks, id)) if (!direct.has(ancestor)) ancestorIds.add(ancestor);
  const { order } = topologicalSort(tasks);
  for (const id of order) {
    if (!ancestorIds.has(id)) continue;
    const result = results[id];
    if (!result) continue;
    const entry = entryFor(result, tasks[id], "ancestor");
    entry.keyFindings = entry.keyFindings.slice(0, 5);
    const cost = entryTokens(entry);
    if (used + cost > packetTokens * 0.8) break;
    entries.push(entry);
    used += cost;
    if (result.outputRef) packet.artifacts[artifactKeyOf(result.outputRef)] = result.outputRef;
  }
  if (task.partialRef) packet.artifacts[artifactKeyOf(task.partialRef)] = task.partialRef;

  packet.upstream = entries;
  packet.planOutline = renderPlanOutline(tasks, task.id);
  used += estimateTokens(packet.planOutline);
  packet.budget.usedTokens = used;
  return packet;
}

export const summarizeSources = (sources: readonly Source[], limit = 8): string =>
  sources
    .slice(0, limit)
    .map((source, index) => `[${index + 1}] ${truncate(source.title, 120)}${source.url ? ` — ${source.url}` : ""}`)
    .join("\n");
