import { addUsage, emptyUsage, type Tier, type Usage } from "../common.js";
import type { LifecycleEvent } from "../events.js";
import type { Projection } from "./fold.js";

export type ToolCallActivity = {
  tool: string;
  callId: string | null;
  args: string;
  startedAt: string;
  ok: boolean | null;
  durationMs: number | null;
  preview: string | null;
};

export type DispatchStatus = "queued" | "running" | "evaluating" | "done";

export type DispatchActivity = {
  dispatchId: string;
  taskId: string | null;
  agentId: string | null;
  attempt: number | null;
  tier: Tier | null;
  model: string | null;
  status: DispatchStatus;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastActivityAt: string;
  modelCalls: number;
  usage: Usage;
  tools: ToolCallActivity[];
  skills: string[];
  thoughts: string[];
  /** MCP tool servers the agent could not use for this attempt. */
  unavailableToolServers: string[];
  outcomeStatus: string | null;
  decision: string | null;
  error: string | null;
};

export type AgentTotals = { dispatches: number; completed: number; failed: number; usage: Usage };

export type AgentActivityView = {
  order: string[];
  dispatches: Record<string, DispatchActivity>;
  agents: Record<string, AgentTotals>;
};

const MAX_THOUGHTS = 8;
const MAX_TOOLS = 60;

function newDispatch(event: LifecycleEvent, dispatchId: string): DispatchActivity {
  return {
    dispatchId,
    taskId: event.taskId,
    agentId: event.agentId,
    attempt: event.attempt,
    tier: null,
    model: null,
    status: "queued",
    queuedAt: event.ts,
    startedAt: null,
    finishedAt: null,
    lastActivityAt: event.ts,
    modelCalls: 0,
    usage: emptyUsage(),
    tools: [],
    skills: [],
    thoughts: [],
    unavailableToolServers: [],
    outcomeStatus: null,
    decision: null,
    error: null,
  };
}

function updateDispatch(
  view: AgentActivityView,
  event: LifecycleEvent,
  dispatchId: string,
  update: (dispatch: DispatchActivity) => DispatchActivity,
): AgentActivityView {
  const existing = view.dispatches[dispatchId];
  const base = existing ?? newDispatch(event, dispatchId);
  const next = { ...update(base), lastActivityAt: event.ts };
  return {
    ...view,
    order: existing ? view.order : [...view.order, dispatchId],
    dispatches: { ...view.dispatches, [dispatchId]: next },
  };
}

function updateAgent(
  view: AgentActivityView,
  agentId: string | null,
  update: (totals: AgentTotals) => AgentTotals,
): AgentActivityView {
  if (!agentId) return view;
  const totals = view.agents[agentId] ?? { dispatches: 0, completed: 0, failed: 0, usage: emptyUsage() };
  return { ...view, agents: { ...view.agents, [agentId]: update(totals) } };
}

export const agentActivityProjection: Projection<AgentActivityView> = {
  name: "agentActivity",
  init: () => ({ order: [], dispatches: {}, agents: {} }),
  apply(view, event) {
    switch (event.type) {
      case "task.dispatched": {
        const next = updateDispatch(view, event, event.data.dispatchId, (dispatch) => ({
          ...dispatch,
          agentId: event.data.agentId,
          attempt: event.data.attempt,
          tier: event.data.tier,
          model: event.data.model,
        }));
        return updateAgent(next, event.data.agentId, (totals) => ({ ...totals, dispatches: totals.dispatches + 1 }));
      }
      case "agent.started":
        return updateDispatch(view, event, event.data.dispatchId, (dispatch) => ({
          ...dispatch,
          status: "running",
          startedAt: event.ts,
          tier: event.data.tier,
          model: event.data.model,
          unavailableToolServers: event.data.unavailableToolServers ?? [],
        }));
      case "agent.model.started":
        return updateDispatch(view, event, event.data.dispatchId, (dispatch) => dispatch);
      case "agent.model.finished":
        return updateDispatch(view, event, event.data.dispatchId, (dispatch) => ({
          ...dispatch,
          modelCalls: dispatch.modelCalls + 1,
          usage: addUsage(dispatch.usage, event.data.usage),
        }));
      case "agent.tool.started":
        return updateDispatch(view, event, event.data.dispatchId, (dispatch) => ({
          ...dispatch,
          tools: [
            ...dispatch.tools,
            {
              tool: event.data.tool,
              callId: event.data.callId,
              args: event.data.args,
              startedAt: event.ts,
              ok: null,
              durationMs: null,
              preview: null,
            },
          ].slice(-MAX_TOOLS),
        }));
      case "agent.tool.finished":
        return updateDispatch(view, event, event.data.dispatchId, (dispatch) => {
          const tools = dispatch.tools.slice();
          let index = -1;
          for (let i = tools.length - 1; i >= 0; i--) {
            const call = tools[i];
            if (!call || call.ok !== null) continue;
            if (event.data.callId ? call.callId === event.data.callId : call.tool === event.data.tool) {
              index = i;
              break;
            }
          }
          const finished = {
            ok: event.data.ok,
            durationMs: event.data.durationMs,
            preview: event.data.preview,
          };
          const existing = index >= 0 ? tools[index] : undefined;
          if (existing) tools[index] = { ...existing, ...finished };
          else {
            tools.push({
              tool: event.data.tool,
              callId: event.data.callId,
              args: "",
              startedAt: event.ts,
              ...finished,
            });
          }
          return { ...dispatch, tools: tools.slice(-MAX_TOOLS) };
        });
      case "agent.skill.loaded":
        return updateDispatch(view, event, event.data.dispatchId, (dispatch) => ({
          ...dispatch,
          skills: dispatch.skills.includes(event.data.skill) ? dispatch.skills : [...dispatch.skills, event.data.skill],
        }));
      case "agent.thought":
        return updateDispatch(view, event, event.data.dispatchId, (dispatch) => ({
          ...dispatch,
          thoughts: [...dispatch.thoughts, event.data.text].slice(-MAX_THOUGHTS),
        }));
      case "agent.finished":
        return updateDispatch(view, event, event.data.dispatchId, (dispatch) => ({
          ...dispatch,
          outcomeStatus: event.data.outcomeStatus,
          error: event.data.error,
        }));
      case "evaluation.started":
        return updateDispatch(view, event, event.data.dispatchId, (dispatch) => ({ ...dispatch, status: "evaluating" }));
      case "evaluation.completed": {
        const next = updateDispatch(view, event, event.data.dispatchId, (dispatch) => ({
          ...dispatch,
          status: "done",
          finishedAt: dispatch.finishedAt ?? event.ts,
          decision: event.data.decision,
          outcomeStatus: event.data.outcomeStatus ?? dispatch.outcomeStatus,
          error: event.data.error ?? dispatch.error,
          tier: event.data.tier,
          model: event.data.model,
          // The durable report is authoritative (includes judge usage and calls made before a reconnect).
          usage: event.data.usage,
          modelCalls: Math.max(dispatch.modelCalls, event.data.usage.modelCalls),
        }));
        return updateAgent(next, event.agentId, (totals) => ({ ...totals, usage: addUsage(totals.usage, event.data.usage) }));
      }
      case "task.report_discarded":
        return updateDispatch(view, event, event.data.dispatchId, (dispatch) => ({
          ...dispatch,
          status: "done",
          finishedAt: dispatch.finishedAt ?? event.ts,
        }));
      case "task.completed":
        return updateAgent(view, event.agentId, (totals) => ({ ...totals, completed: totals.completed + 1 }));
      case "task.failed":
        return event.data.dispatchId
          ? updateAgent(view, event.agentId, (totals) => ({ ...totals, failed: totals.failed + 1 }))
          : view;
      default:
        return view;
    }
  },
};

export function activeDispatches(view: AgentActivityView, agentId?: string): DispatchActivity[] {
  return view.order
    .map((id) => view.dispatches[id])
    .filter(
      (dispatch): dispatch is DispatchActivity =>
        dispatch !== undefined && dispatch.status !== "done" && (agentId === undefined || dispatch.agentId === agentId),
    );
}
