import { useId, useMemo, useState } from "react";
import { buttonClass } from "../../../components/ui/Button";
import { SegmentedControl, Select } from "../../../components/ui/Form";
import { IconBoard, IconGraph, IconHelp } from "../../../components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/Overlay";
import { OriginMark } from "../../../components/ui/Status";
import { Card, EmptyState } from "../../../components/ui/Surface";
import { RelativeTime } from "../../../components/ui/time";
import { useMediaQuery } from "../../../hooks/useMediaQuery";
import { cx } from "../../../lib/cx";
import { EDGE_STATE_TONE } from "../../../lib/status";
import { PLAN_SOURCE_LABEL, changedTasks, describeDiff } from "../../../view-models/plan";
import { useRunView } from "../run-context";
import { PlanBoard } from "./PlanBoard";
import { PlanGraph } from "./PlanGraph";

type PlanView = "graph" | "board";

function Legend() {
  return (
    <Popover>
      <PopoverTrigger className={cx(buttonClass("ghost", "sm"))} aria-label="How to read the plan">
        <IconHelp size={15} aria-hidden="true" />
        <span className="hidden sm:inline">Legend</span>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-72 p-4">
        <p className="text-sm font-semibold">Reading the plan</p>
        <p className="mt-1 text-xs text-fg-2">Arrows point from a task to the tasks that wait for it.</p>
        <ul className="mt-3 flex flex-col gap-2 text-sm">
          {(["satisfied", "pending", "broken"] as const).map((state) => (
            <li key={state} className="flex items-center gap-3">
              <svg width="28" height="8" aria-hidden="true" className="shrink-0">
                <line x1="0" y1="4" x2="28" y2="4" stroke={EDGE_STATE_TONE[state].stroke} strokeWidth="2" strokeDasharray={EDGE_STATE_TONE[state].dash} />
              </svg>
              <span className="text-fg-2">
                {state === "satisfied" ? "Input is ready" : state === "pending" ? "Waiting for the input" : "Input failed or was removed"}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs font-medium text-fg-3">Tasks added after the first plan</p>
        <ul className="mt-2 flex flex-col gap-1.5 text-sm text-fg-2">
          {(["proposal", "replan", "revision", "human"] as const).map((origin) => (
            <li key={origin} className="flex items-center gap-2">
              <OriginMark origin={origin} size={14} />
              {origin === "proposal" ? "Suggested by an agent" : origin === "replan" ? "Added by replanning" : origin === "revision" ? "Revision of a finished task" : "Added by you"}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export default function PlanTab() {
  const ids = useId();
  const { session, status, selectedTaskId, selectTask, agentName } = useRunView();
  const { views, values } = session;
  const narrow = !useMediaQuery("(min-width: 768px)");
  const [viewChoice, setViewChoice] = useState<PlanView | null>(null);
  const view: PlanView = viewChoice ?? (narrow ? "board" : "graph");

  const history = views.dag.history;
  const latest = history.at(-1) ?? null;
  const [pinnedVersion, setPinnedVersion] = useState<number | null>(null);
  const pinned = pinnedVersion !== null ? (history.find((entry) => entry.version === pinnedVersion) ?? null) : null;
  const focus = pinned ?? latest;
  const changes = useMemo(() => changedTasks(focus, pinned !== null || history.length > 1), [focus, pinned, history.length]);

  if (views.taskBoard.order.length === 0) {
    return (
      <Card>
        <EmptyState icon={<IconGraph size={28} aria-hidden="true" />} title="No plan yet" hint="The plan appears here once the planner breaks the request into tasks." />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl<PlanView>
          label="Plan view"
          value={view}
          onValueChange={setViewChoice}
          options={[
            { value: "graph", label: "Graph", icon: <IconGraph size={14} aria-hidden="true" /> },
            { value: "board", label: "Board", icon: <IconBoard size={14} aria-hidden="true" /> },
          ]}
        />
        {history.length > 0 && (
          <div className="flex items-center gap-2">
            <label htmlFor={`${ids}-version`} className="text-sm text-fg-2">
              Version
            </label>
            <Select
              id={`${ids}-version`}
              value={pinnedVersion === null ? "latest" : String(pinnedVersion)}
              onChange={(event) => setPinnedVersion(event.target.value === "latest" ? null : Number(event.target.value))}
            >
              <option value="latest">Latest (v{latest?.version})</option>
              {[...history].reverse().map((entry) => (
                <option key={`${entry.version}-${entry.ts}`} value={entry.version}>
                  v{entry.version}: {PLAN_SOURCE_LABEL[entry.source]}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="ml-auto">
          <Legend />
        </div>
      </div>

      {focus && (
        <p className="text-sm text-fg-2">
          <span className="font-medium text-fg">
            Version {focus.version}, {PLAN_SOURCE_LABEL[focus.source].toLowerCase() === "you" ? "edited by you" : `by the ${PLAN_SOURCE_LABEL[focus.source].toLowerCase()}`}
          </span>
          {history.length > 1 || pinned ? `: ${describeDiff(focus)}. ` : ". "}
          {focus.reason}
          <span className="text-fg-3">
            {" "}
            <RelativeTime ts={focus.ts} />
          </span>
        </p>
      )}

      {view === "graph" ? (
        <Card className="h-[calc(100dvh-19rem)] min-h-[440px] overflow-hidden">
          <PlanGraph
            board={views.taskBoard}
            dag={views.dag}
            tasks={values.tasks}
            run={status}
            changes={changes}
            selectedTaskId={selectedTaskId}
            onSelectTask={selectTask}
            agentName={agentName}
          />
        </Card>
      ) : (
        <PlanBoard board={views.taskBoard} />
      )}
    </div>
  );
}
