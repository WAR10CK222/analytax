import { isTerminalStatus, type PlanOp, type Proposal, type Task } from "@analytax/contracts";
import type { AgentRegistry } from "../agents/registry.js";
import type { Guards } from "../config/schema.js";
import { compareTaskIds, dependentsIndex, type TaskMap } from "../planning/dag.js";
import { findDuplicateTask } from "../planning/fingerprint.js";

export type ProposalDisposition =
  | { kind: "ops"; proposal: Proposal; ops: PlanOp[]; primaryRef: string | null; revisionOf: string | null }
  | { kind: "defer"; proposal: Proposal; reason: string }
  | { kind: "drop"; proposal: Proposal; reason: string };

export type ProposalContext = {
  task: Task;
  tasks: TaskMap;
  agents: AgentRegistry;
  guards: Guards;
  autoSpawned: number;
  autoSpawnFrozen: boolean;
};

const source = (task: Task) => ({ kind: "proposal" as const, taskId: task.id });

// Provenance lives in origin/whyThisTask, not in the instructions, so identical proposals fingerprint identically.
function newTaskSpec(proposal: Proposal, proposer: Task, agentId: string, dependsOn: string[]) {
  return {
    title: proposal.title,
    instructions: proposal.instructions,
    acceptanceCriteria: [`Fully addresses: ${proposal.title}`, "Consistent with the upstream results provided as context"],
    checks: [],
    capability: proposal.capability,
    agentId,
    complexity: proposer.complexity,
    tierOverride: null,
    dependsOn,
    dependencyPolicy: "all" as const,
    contextFrom: [],
    critical: false,
    evaluation: "auto" as const,
  };
}

/**
 * Turns proposals from an ACCEPTED outcome into plan ops (auto-accept), replanner requests (defer) or drops.
 * - follow_up that matches a completed upstream capability → revise that task (e.g. critic → writer revision)
 * - other follow_up → new task after the proposer; the proposer's pending dependents wait for it
 * - prerequisite discovered after acceptance → new task + revision of the proposer
 */
export function disposeProposals(ctx: ProposalContext, proposals: readonly Proposal[]): ProposalDisposition[] {
  const { task, tasks, agents, guards } = ctx;
  const dispositions: ProposalDisposition[] = [];
  let spawned = ctx.autoSpawned;
  const index = dependentsIndex(tasks);

  proposals.slice(0, guards.maxProposalsPerTask).forEach((proposal, i) => {
    if (proposal.kind === "clarification") {
      dispositions.push({ kind: "drop", proposal, reason: "recorded as an open question" });
      return;
    }
    if (proposal.kind === "decompose") {
      dispositions.push({ kind: "defer", proposal, reason: "decomposition requires the replanner" });
      return;
    }
    const agent = agents.bestFor(proposal.capability);
    if (!agent) {
      dispositions.push({ kind: "defer", proposal, reason: `no agent offers capability '${proposal.capability}'` });
      return;
    }
    if (ctx.autoSpawnFrozen) {
      dispositions.push({ kind: "defer", proposal, reason: "auto-accepting proposals is frozen (plan growth guard)" });
      return;
    }
    if (spawned >= guards.maxAutoSpawned) {
      dispositions.push({ kind: "defer", proposal, reason: `auto-accepted proposal limit reached (${guards.maxAutoSpawned})` });
      return;
    }
    if (task.origin.depth + 1 > guards.maxSpawnDepth) {
      dispositions.push({ kind: "drop", proposal, reason: `maximum spawn depth (${guards.maxSpawnDepth}) reached` });
      return;
    }
    const duplicate = findDuplicateTask(Object.values(tasks), proposal, { near: true });
    if (duplicate) {
      dispositions.push({ kind: "drop", proposal, reason: `duplicate of ${duplicate.id} ("${duplicate.title}")` });
      return;
    }

    const ref = `proposal_${task.id}_${i + 1}`;
    if (proposal.kind === "follow_up") {
      const target = task.dependsOn
        .map((id) => tasks[id])
        .filter(
          (candidate): candidate is Task =>
            candidate !== undefined &&
            candidate.status === "completed" &&
            candidate.capability === proposal.capability &&
            candidate.revisions < guards.maxRevisionsPerTask,
        )
        .sort((a, b) => compareTaskIds(b.id, a.id))[0];
      if (target) {
        spawned++;
        dispositions.push({
          kind: "ops",
          proposal,
          primaryRef: null,
          revisionOf: target.id,
          ops: [
            {
              op: "revise_task",
              taskId: target.id,
              instructions: `${target.instructions}\n\nREVISION REQUESTED by ${task.id} ("${task.title}"). Apply every change below; keep what was already correct:\n${proposal.instructions}`,
              waitFor: [task.id],
              reason: proposal.rationale || `Revision requested by ${task.id}`,
              source: source(task),
            },
          ],
        });
        return;
      }
      const waiting = (index.get(task.id) ?? [])
        .map((id) => tasks[id])
        .filter((dependent): dependent is Task => dependent !== undefined && !isTerminalStatus(dependent.status) && dependent.status !== "working");
      spawned++;
      dispositions.push({
        kind: "ops",
        proposal,
        primaryRef: ref,
        revisionOf: null,
        ops: [
          {
            op: "add_task",
            ref,
            originKind: null,
            task: newTaskSpec(proposal, task, agent.id, [task.id]),
            reason: proposal.rationale || `Follow-up proposed by ${task.id}`,
            source: source(task),
          },
          ...waiting.map(
            (dependent): PlanOp => ({
              op: "add_dependency",
              taskId: dependent.id,
              dependsOn: ref,
              reason: `Wait for follow-up "${proposal.title}"`,
              source: source(task),
            }),
          ),
        ],
      });
      return;
    }

    // prerequisite discovered after the proposer was accepted → do it, then revise the proposer.
    spawned++;
    dispositions.push({
      kind: "ops",
      proposal,
      primaryRef: ref,
      revisionOf: task.id,
      ops: [
        {
          op: "add_task",
          ref,
          originKind: null,
          task: newTaskSpec(proposal, task, agent.id, []),
          reason: proposal.rationale || `Prerequisite discovered by ${task.id}`,
          source: source(task),
        },
        {
          op: "revise_task",
          taskId: task.id,
          instructions: `${task.instructions}\n\nREVISE using the result of the newly completed prerequisite "${proposal.title}".`,
          waitFor: [ref],
          reason: `Incorporate prerequisite "${proposal.title}"`,
          source: source(task),
        },
      ],
    });
  });
  return dispositions;
}

/** Ops that insert a prerequisite before a blocked task (or link it to an equivalent existing task). */
export function prerequisiteOps(
  task: Task,
  prerequisite: Proposal,
  tasks: TaskMap,
  agents: AgentRegistry,
): { ops: PlanOp[]; ref: string | null; linkedTo: string | null } | { defer: string } {
  const agent = agents.bestFor(prerequisite.capability);
  if (!agent) return { defer: `no agent offers capability '${prerequisite.capability}'` };
  const duplicate = findDuplicateTask(Object.values(tasks), prerequisite, { near: true, excludeIds: new Set([task.id]) });
  const policySource = { kind: "policy" as const, taskId: task.id };
  if (duplicate) {
    return {
      ref: null,
      linkedTo: duplicate.id,
      ops: [
        {
          op: "add_dependency",
          taskId: task.id,
          dependsOn: duplicate.id,
          reason: `Blocked on existing task ${duplicate.id} ("${duplicate.title}")`,
          source: policySource,
        },
      ],
    };
  }
  const ref = `prereq_${task.id}_${task.blockCount + 1}`;
  return {
    ref,
    linkedTo: null,
    ops: [
      {
        op: "add_task",
        ref,
        originKind: null,
        task: { ...newTaskSpec(prerequisite, task, agent.id, []), critical: task.critical },
        reason: prerequisite.rationale || `Prerequisite discovered by ${task.id}`,
        source: policySource,
      },
      { op: "add_dependency", taskId: task.id, dependsOn: ref, reason: `Wait for prerequisite "${prerequisite.title}"`, source: policySource },
    ],
  };
}
