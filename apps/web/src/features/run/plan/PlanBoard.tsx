import type { TaskBoardView, TaskCard } from "@analytax/contracts";
import { useMemo } from "react";
import { OriginMark, StatusText } from "../../../components/ui/Status";
import { EmptyState } from "../../../components/ui/Surface";
import { cx } from "../../../lib/cx";
import { formatScore } from "../../../lib/format";
import { TIER_LABEL } from "../../../lib/status";
import { LANE_LABEL, LANES, cardTone, groupByLane, isSuperseded, pendingDependencies } from "../../../view-models/tasks";
import { useRunView } from "../run-context";

function BoardCard({ card, board }: { card: TaskCard; board: TaskBoardView }) {
  const { session, status, selectTask, selectedTaskId, agentName, taskTitle } = useRunView();
  const task = session.values.tasks?.[card.id];
  const tone = cardTone(board, card, task, status);
  const waitsOn = card.status === "submitted" ? pendingDependencies(board, card) : [];
  const muted = isSuperseded(card, task) || card.status === "canceled";
  const selected = selectedTaskId === card.id;
  return (
    <li>
      <button
        type="button"
        onClick={() => selectTask(card.id)}
        aria-current={selected ? "true" : undefined}
        className={cx(
          "ax-press flex w-full flex-col gap-2 rounded-md border bg-surface px-3 py-2.5 text-left hover:border-line-strong",
          muted ? "border-dashed border-line-strong" : "border-line",
          selected && "shadow-[0_0_0_2px_var(--ax-fg)]",
        )}
      >
        <span className="flex items-start gap-2">
          <span className={cx("line-clamp-2 min-w-0 flex-1 text-sm font-medium leading-snug", muted ? "text-fg-3 line-through" : "text-fg")}>{card.title}</span>
          <OriginMark origin={card.originKind} size={13} />
        </span>
        <StatusText tone={tone} className="text-xs" />
        <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-fg-3">
          <span>{agentName(card.agentId)}</span>
          {card.tier && <span>{TIER_LABEL[card.tier]}</span>}
          {card.attempt > 1 && <span>Attempt {card.attempt}</span>}
          {card.score !== null && <span className="tabular">Score {formatScore(card.score)}</span>}
          {card.critical && <span>Critical</span>}
        </span>
        {waitsOn.length > 0 && <span className="line-clamp-2 text-xs text-fg-3">Waits for {waitsOn.map(taskTitle).join(", ")}</span>}
        {card.statusReason && card.statusReason !== "superseded" && <span className="line-clamp-2 text-xs text-fg-2" title={card.statusReason}>{card.statusReason}</span>}
      </button>
    </li>
  );
}

export function PlanBoard({ board }: { board: TaskBoardView }) {
  const lanes = useMemo(() => groupByLane(board), [board]);
  if (board.order.length === 0) return <EmptyState title="No tasks yet" hint="Tasks appear here once the planner commits a plan." />;
  return (
    // Phones get one column with empty lanes hidden; wider screens get four lanes that scroll sideways if needed.
    <div className="scroll-thin -mx-1 px-1 pb-2 md:overflow-x-auto">
      <div className="grid grid-cols-1 gap-5 md:min-w-[56rem] md:grid-cols-4 md:gap-4">
        {LANES.map((lane) => (
          <section key={lane} aria-label={LANE_LABEL[lane]} className={cx("flex min-w-0 flex-col gap-2.5", lanes[lane].length === 0 && "max-md:hidden")}>
            <h3 className="flex items-center gap-2 px-1 text-sm font-medium text-fg">
              {LANE_LABEL[lane]}
              <span className="tabular text-xs font-normal text-fg-3">{lanes[lane].length}</span>
            </h3>
            {lanes[lane].length === 0 ? (
              <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-fg-3">Nothing here</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {lanes[lane].map((card) => (
                  <BoardCard key={card.id} card={card} board={board} />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
