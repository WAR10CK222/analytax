import { formatToolName, type AgentActivityView, type DispatchActivity, type LifecycleEvent, type TaskBoardView, type Tier } from "@analytax/contracts";

/** Thought summaries arrive as markdown ("**Heading** text"); the one-line preview shows plain words. */
export const plainThought = (text: string): string =>
  text
    .replace(/\*\*|__|`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();

export type CurrentActivity = { kind: "tool" | "thought" | "evaluating" | "model" | "starting"; text: string };

/** One line describing what an agent is doing right now. */
export function currentActivity(dispatch: DispatchActivity): CurrentActivity {
  if (dispatch.status === "evaluating") return { kind: "evaluating", text: "Checking the result against the acceptance criteria" };
  if (dispatch.status === "queued") return { kind: "starting", text: "Starting" };
  const tool = dispatch.tools.at(-1);
  if (tool && tool.ok === null) return { kind: "tool", text: `Using ${formatToolName(tool.tool)}` };
  const thought = dispatch.thoughts.at(-1);
  if (thought && (!tool || dispatch.lastActivityAt >= tool.startedAt)) return { kind: "thought", text: plainThought(thought) };
  if (tool) return { kind: "tool", text: tool.ok ? `Used ${formatToolName(tool.tool)}` : `${formatToolName(tool.tool)} failed` };
  return { kind: "model", text: dispatch.modelCalls > 0 ? `Working (${dispatch.modelCalls} model calls)` : "Working" };
}

export function lastSignalByDispatch(live: readonly LifecycleEvent[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const event of live) if (event.dispatchId) map.set(event.dispatchId, event.ts);
  return map;
}

export type NowItem = {
  dispatchId: string;
  taskId: string | null;
  taskTitle: string;
  agentId: string | null;
  agentName: string;
  attempt: number | null;
  tier: Tier | null;
  model: string | null;
  startedAt: string | null;
  activity: CurrentActivity;
  status: DispatchActivity["status"];
};

/** Active dispatches for the Overview "Now" list, oldest first. Only meaningful while the run is running. */
export function nowItems(activity: AgentActivityView, board: TaskBoardView, agentName: (id: string) => string): NowItem[] {
  return activity.order
    .map((id) => activity.dispatches[id])
    .filter((dispatch): dispatch is DispatchActivity => dispatch !== undefined && dispatch.status !== "done")
    .map((dispatch) => ({
      dispatchId: dispatch.dispatchId,
      taskId: dispatch.taskId,
      taskTitle: dispatch.taskId ? (board.cards[dispatch.taskId]?.title ?? dispatch.taskId) : "Task",
      agentId: dispatch.agentId,
      agentName: dispatch.agentId ? agentName(dispatch.agentId) : "Agent",
      attempt: dispatch.attempt,
      tier: dispatch.tier,
      model: dispatch.model,
      startedAt: dispatch.startedAt ?? dispatch.queuedAt,
      activity: currentActivity(dispatch),
      status: dispatch.status,
    }));
}

/** Every dispatch that ran for a task, newest first. */
export function dispatchesForTask(activity: AgentActivityView, taskId: string): DispatchActivity[] {
  return activity.order
    .map((id) => activity.dispatches[id])
    .filter((dispatch): dispatch is DispatchActivity => dispatch !== undefined && dispatch.taskId === taskId)
    .reverse();
}
