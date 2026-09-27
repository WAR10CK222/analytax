import type { TimelineEntry } from "@analytax/contracts";
import { useId, useMemo, useState } from "react";
import { SegmentedControl, Select, SwitchField } from "../../../components/ui/Form";
import { StatusIcon } from "../../../components/ui/Status";
import { Card, EmptyState } from "../../../components/ui/Surface";
import { TaskLink } from "../../../components/ui/TaskLink";
import { cx } from "../../../lib/cx";
import { formatClock, formatDateTime } from "../../../lib/format";
import { LEVEL_TONE } from "../../../lib/status";
import { activityCounts, isWaveMarker, liveStepEntries, mergeEntries, selectActivity, type ActivityFilter } from "../../../view-models/activity";
import { orderedCards } from "../../../view-models/tasks";
import { useRunView } from "../run-context";

const MAX_ROWS = 600;
const LONG_DETAIL = 240;

function ActivityRow({ entry }: { entry: TimelineEntry }) {
  const { selectTask, taskTitle, agentName } = useRunView();
  const [expanded, setExpanded] = useState(false);
  const tone = LEVEL_TONE[entry.level];
  const long = (entry.detail?.length ?? 0) > LONG_DETAIL;
  return (
    <li className="grid grid-cols-[4.75rem_1rem_minmax(0,1fr)] gap-x-3 px-4 py-2.5">
      <time dateTime={entry.ts} title={formatDateTime(entry.ts)} className="tabular pt-px text-xs text-fg-3">
        {formatClock(entry.ts)}
      </time>
      <span className="pt-0.5">
        <StatusIcon tone={tone} size={14} />
        <span className="sr-only">{tone.label}</span>
      </span>
      <div className="min-w-0">
        <p className="text-sm text-fg">
          {entry.title}
          {entry.durability === "ephemeral" && <span className="ml-2 text-xs text-fg-3">live</span>}
        </p>
        {(entry.taskId || entry.agentId) && (
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-fg-3">
            {entry.taskId && <TaskLink id={entry.taskId} title={taskTitle(entry.taskId)} onSelect={selectTask} className="text-xs text-fg-2" />}
            {entry.agentId && <span>{agentName(entry.agentId)}</span>}
          </p>
        )}
        {entry.detail && (
          <div className="mt-1">
            <p className={cx("text-sm break-words whitespace-pre-wrap text-fg-2", !expanded && "line-clamp-3")}>{entry.detail}</p>
            {long && (
              <button type="button" onClick={() => setExpanded((value) => !value)} className="mt-1 text-xs text-fg-2 underline decoration-line-strong underline-offset-2 hover:text-fg">
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function WaveDivider({ entry }: { entry: TimelineEntry }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2" aria-label={entry.title}>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
      <span className="text-xs text-fg-3">
        {entry.title} at <time dateTime={entry.ts}>{formatClock(entry.ts)}</time>
      </span>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
    </li>
  );
}

export function ActivityTab() {
  const ids = useId();
  const { session } = useRunView();
  const { views, liveEvents } = session;
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [showAgentSteps, setShowAgentSteps] = useState(false);

  const entries = useMemo(
    () => (showAgentSteps ? mergeEntries(views.timeline.entries, liveStepEntries(liveEvents)) : views.timeline.entries),
    [showAgentSteps, views.timeline.entries, liveEvents],
  );
  const rows = useMemo(() => selectActivity(entries, { filter, taskId, showAgentSteps, limit: MAX_ROWS }), [entries, filter, taskId, showAgentSteps]);
  const counts = useMemo(() => activityCounts(entries, taskId, showAgentSteps), [entries, taskId, showAgentSteps]);
  const tasks = useMemo(() => orderedCards(views.taskBoard), [views.taskBoard]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <SegmentedControl<ActivityFilter>
          label="Show"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: "all", label: "All", count: counts.all },
            { value: "decisions", label: "Decisions", count: counts.decisions },
            { value: "tasks", label: "Tasks", count: counts.tasks },
            { value: "issues", label: "Issues", count: counts.issues },
          ]}
        />
        <div className="flex items-center gap-2">
          <label htmlFor={`${ids}-task`} className="text-sm text-fg-2">
            Task
          </label>
          <Select id={`${ids}-task`} value={taskId ?? ""} onChange={(event) => setTaskId(event.target.value || null)} className="max-w-64">
            <option value="">All tasks</option>
            {tasks.map((card) => (
              <option key={card.id} value={card.id}>
                {card.title}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-full sm:ml-auto sm:w-auto">
          <SwitchField label="Show agent steps" checked={showAgentSteps} onCheckedChange={setShowAgentSteps} />
        </div>
      </div>
      {showAgentSteps && liveEvents.length === 0 && (
        <p className="text-sm text-fg-2">Agent steps (tool calls and thinking) are only available while you watch a run you started in this tab.</p>
      )}
      <Card>
        {rows.length === 0 ? (
          <EmptyState
            title={entries.length === 0 ? "Nothing has happened yet" : "No activity matches these filters"}
            hint={entries.length === 0 ? "Events appear here as the orchestrator works." : "Try All, or pick a different task."}
          />
        ) : (
          <ol className="divide-y divide-line">
            {rows.map((entry) => (isWaveMarker(entry) ? <WaveDivider key={entry.id} entry={entry} /> : <ActivityRow key={entry.id} entry={entry} />))}
          </ol>
        )}
      </Card>
      {entries.length > MAX_ROWS && <p className="text-xs text-fg-3">Showing the latest {MAX_ROWS} events.</p>}
    </div>
  );
}
