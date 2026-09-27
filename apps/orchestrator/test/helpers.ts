import path from "node:path";
import {
  emptyUsage,
  type NewTask,
  type OpSource,
  type PlanOp,
  type Task,
  type TaskOrigin,
  type TaskOutcome,
  type Verdict,
  type WorkerReport,
} from "@analytax/contracts";
import { AgentRegistry } from "../src/agents/registry.js";
import { loadConfig, type AppConfig } from "../src/config/load.js";
import { McpHub } from "../src/mcp/hub.js";
import { createTask, type ApplyContext } from "../src/planning/apply-plan-ops.js";
import { taskNumber } from "../src/planning/dag.js";

export const NOW = "2026-09-10T12:00:00.000Z";

export const testConfig = (): AppConfig => loadConfig();

/** The repo MCP config with MCP switched off: tests never touch the network unless they build their own hub. */
export const testMcpHub = (): McpHub => McpHub.create(testConfig().mcp, { env: {}, offline: true });

let agents: AgentRegistry | null = null;
export function testAgents(): AgentRegistry {
  if (agents) return agents;
  const config = testConfig();
  agents = AgentRegistry.load(path.join(config.home, config.orchestrator.paths.agents), {
    toolNames: new Set(["web_search", "fetch_url", "calculator", "current_datetime"]),
    hasSkill: () => true,
    mcpServers: testMcpHub().serverIds(),
  });
  return agents;
}

export const planner: OpSource = { kind: "planner", taskId: null };

export function spec(overrides: Partial<NewTask> & { title: string }): NewTask {
  return {
    instructions: `Do the work for: ${overrides.title}`,
    acceptanceCriteria: ["The work is complete"],
    checks: [],
    capability: "web_research",
    agentId: "researcher",
    complexity: "medium",
    tierOverride: null,
    dependsOn: [],
    dependencyPolicy: "all",
    contextFrom: [],
    critical: false,
    evaluation: "auto",
    ...overrides,
  };
}

export const addOp = (ref: string, task: NewTask, source: OpSource = planner): PlanOp => ({
  op: "add_task",
  ref,
  originKind: null,
  task,
  reason: "test",
  source,
});

export const seqOf = (tasks: Readonly<Record<string, Task>>): number =>
  Object.keys(tasks).reduce((max, id) => Math.max(max, taskNumber(id)), 0);

export function applyContext(tasks: Readonly<Record<string, Task>>, overrides: Partial<ApplyContext> = {}): ApplyContext {
  return {
    agents: testAgents(),
    guards: testConfig().orchestrator.guards,
    now: NOW,
    planVersion: 1,
    taskSeq: seqOf(tasks),
    spentFingerprints: [],
    ...overrides,
  };
}

export type LedgerDef = {
  id: string;
  title?: string;
  deps?: string[];
  status?: Task["status"];
  critical?: boolean;
  policy?: Task["dependencyPolicy"];
  agentId?: string;
  capability?: string;
  origin?: Partial<TaskOrigin>;
  revisionOf?: string | null;
  statusReason?: string | null;
  attempt?: number;
  tier?: Task["currentTier"];
};

export function makeTask(def: LedgerDef): Task {
  const title = def.title ?? `Task ${def.id}`;
  const task = createTask({
    id: def.id,
    spec: spec({
      title,
      dependsOn: def.deps ?? [],
      critical: def.critical ?? false,
      dependencyPolicy: def.policy ?? "all",
      agentId: def.agentId ?? "researcher",
      capability: def.capability ?? "web_research",
    }),
    origin: { kind: "plan", parentTaskId: null, planVersion: 1, depth: 0, ...def.origin },
    now: NOW,
    revisionOf: def.revisionOf ?? null,
  });
  return {
    ...task,
    status: def.status ?? "submitted",
    statusReason: def.statusReason ?? null,
    attempt: def.attempt ?? 0,
    currentTier: def.tier ?? null,
  };
}

export const ledger = (defs: LedgerDef[]): Record<string, Task> => Object.fromEntries(defs.map((def) => [def.id, makeTask(def)]));

export function outcome(overrides: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    status: "completed",
    summary: "A short summary of the result.",
    output: "A sufficiently long output that satisfies the deterministic checks for testing.",
    keyFindings: ["finding"],
    sources: [{ title: "Example", url: "https://example.com" }],
    confidence: 0.9,
    assumptions: [],
    openQuestions: [],
    proposals: [],
    ...overrides,
  };
}

export function verdict(decision: Verdict["decision"], overrides: Partial<Verdict> = {}): Verdict {
  return {
    decision,
    score: decision === "accept" ? 0.9 : 0.3,
    evaluatedBy: "llm",
    criteria: [{ criterion: "The work is complete", met: decision === "accept", note: "test" }],
    issues: decision === "accept" ? [] : [{ severity: "major", text: "Missing detail" }],
    feedback: decision === "accept" ? "" : "Add the missing detail.",
    missingPrerequisite: null,
    ...overrides,
  };
}

export function makeReport(task: Task, overrides: Partial<WorkerReport> = {}): WorkerReport {
  return {
    dispatchId: task.activeDispatchId ?? `${task.id}.a${task.attempt}.w1`,
    taskId: task.id,
    attempt: task.attempt,
    wave: 1,
    agentId: task.agentId,
    tier: task.currentTier ?? "standard",
    model: "test-model",
    outcome: null,
    outputRef: null,
    error: null,
    checks: [],
    verdict: null,
    outputFingerprint: null,
    usage: emptyUsage(),
    startedAt: NOW,
    durationMs: 10,
    trace: null,
    ...overrides,
  };
}
