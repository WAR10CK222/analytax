import { agentActivityProjection } from "./agent-activity.js";
import { dagProjection } from "./dag.js";
import type { ViewsOf } from "./fold.js";
import { ledgerProjection } from "./ledger.js";
import { metricsProjection } from "./metrics.js";
import { taskBoardProjection } from "./task-board.js";
import { timelineProjection } from "./timeline.js";

export * from "./agent-activity.js";
export * from "./dag.js";
export * from "./fold.js";
export * from "./ledger.js";
export * from "./metrics.js";
export * from "./task-board.js";
export * from "./timeline.js";

export const defaultProjections = {
  taskBoard: taskBoardProjection,
  dag: dagProjection,
  timeline: timelineProjection,
  agentActivity: agentActivityProjection,
  metrics: metricsProjection,
  ledger: ledgerProjection,
} as const;

export type OrchestrationViews = ViewsOf<typeof defaultProjections>;
