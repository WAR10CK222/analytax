import { createContext, useContext } from "react";
import type { RunSession } from "../../app/session";
import type { RunStatus } from "../../view-models/run-status";
import type { taskCounts } from "../../view-models/tasks";

export type RunView = {
  session: RunSession;
  status: RunStatus;
  counts: ReturnType<typeof taskCounts>;
  query: string | null;
  selectedTaskId: string | null;
  selectTask: (taskId: string | null) => void;
  taskTitle: (taskId: string) => string;
  agentName: (agentId: string) => string;
  openInterrupts: () => void;
};

export const RunViewContext = createContext<RunView | null>(null);

export function useRunView(): RunView {
  const value = useContext(RunViewContext);
  if (!value) throw new Error("useRunView must be used inside <RunWorkspace>");
  return value;
}
