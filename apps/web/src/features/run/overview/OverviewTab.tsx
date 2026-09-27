import type { FinalAnswer, RunPhase, TaskCard } from "@analytax/contracts";
import { useMemo } from "react";
import { MarkdownView } from "../../../components/Markdown";
import { CopyButton } from "../../../components/ui/CopyButton";
import { Disclosure } from "../../../components/ui/Disclosure";
import { IconEvaluate, IconExternal, IconThought, IconTool } from "../../../components/ui/icons";
import { OriginMark, StatusBadge, StatusIcon, StatusText, TierText } from "../../../components/ui/Status";
import { Card, KeyValues, Section } from "../../../components/ui/Surface";
import { TaskLink } from "../../../components/ui/TaskLink";
import { Elapsed } from "../../../components/ui/time";
import { cx } from "../../../lib/cx";
import { formatDateTime, formatDuration, pluralize } from "../../../lib/format";
import { humanizeKey, tone } from "../../../lib/status";
import { narrateAdaptations, type Adaptation } from "../../../view-models/adaptations";
import { nowItems, type NowItem } from "../../../view-models/dispatch";
import { deriveProgress } from "../../../view-models/progress";
import { cardTone, overviewGroups } from "../../../view-models/tasks";
import { describeCounts } from "../../../view-models/plan";
import { ProgressRail } from "../ProgressRail";
import { useRunView } from "../run-context";

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
};

function AnswerRail({ final }: { final: FinalAnswer }) {
  const { selectTask } = useRunView();
  const hasCaveats = final.limitations.length > 0 || final.gaps.length > 0;
  return (
    <aside className="flex min-w-0 flex-col gap-6" aria-label="Sources and caveats">
      {hasCaveats && (
        <div>
          <h3 className="text-sm font-semibold text-fg">Caveats</h3>
          <ul className="mt-2 flex flex-col gap-2.5 text-sm text-fg-2">
            {final.limitations.map((limitation, index) => (
              <li key={`l${index}`} className="leading-relaxed">
                {limitation}
              </li>
            ))}
            {final.gaps.map((gap) => (
              <li key={gap.taskId} className="leading-relaxed">
                <TaskLink id={gap.taskId} title={gap.title} onSelect={selectTask} className="font-medium" /> was not completed: {gap.reason}.
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="text-sm font-semibold text-fg">Sources</h3>
        {final.sources.length === 0 ? (
          <p className="mt-2 text-sm text-fg-3">No sources cited.</p>
        ) : (
          <ol className="mt-2 flex flex-col gap-2.5">
            {final.sources.map((source, index) => {
              const host = source.url ? hostOf(source.url) : null;
              return (
                <li key={index} className="flex gap-2 text-sm">
                  <span className="tabular w-5 shrink-0 text-right text-fg-3">{index + 1}</span>
                  <span className="min-w-0">
                    {source.url ? (
                      <a href={source.url} target="_blank" rel="noreferrer noopener" className="group text-fg hover:underline">
                        <span className="break-words">{source.title || host || source.url}</span>
                        <IconExternal size={12} aria-hidden="true" className="ml-1 inline text-fg-3" />
                      </a>
                    ) : (
                      <span className="break-words text-fg">{source.title}</span>
                    )}
                    {host && <span className="block text-xs text-fg-3">{host}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </aside>
  );
}

function AnswerView({ final }: { final: FinalAnswer }) {
  return (
    <Card className="px-5 py-5 sm:px-7 sm:py-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="text-md font-semibold text-fg">Answer</h2>
        <StatusBadge tone={final.status === "partial" ? tone("Partial", "attention", "partial") : tone("Complete", "success")} />
        <span className="text-sm text-fg-3">
          {pluralize(final.completedTaskIds.length, "task")} used, {formatDateTime(final.producedAt)}
        </span>
        <span className="ml-auto">
          <CopyButton text={final.answer} label="Copy answer" />
        </span>
      </div>
      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 max-w-[72ch]">
          <MarkdownView>{final.answer}</MarkdownView>
        </div>
        <div className="border-t border-line pt-6 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-6">
          <AnswerRail final={final} />
        </div>
      </div>
    </Card>
  );
}

const ACTIVITY_ICON = { tool: IconTool, thought: IconThought, evaluating: IconEvaluate, model: IconThought, starting: IconThought } as const;

function NowRow({ item }: { item: NowItem }) {
  const { selectTask } = useRunView();
  const Icon = ACTIVITY_ICON[item.activity.kind];
  return (
    <li>
      <button
        type="button"
        onClick={() => item.taskId && selectTask(item.taskId)}
        className="ax-press flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left hover:bg-hover"
      >
        <StatusIcon tone={tone("Running", "running")} size={16} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium text-fg">{item.taskTitle}</span>
            <span className="text-sm text-fg-2">{item.agentName}</span>
            {item.attempt !== null && item.attempt > 1 && <span className="text-xs text-fg-3">Attempt {item.attempt}</span>}
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm text-fg-2">
            <Icon size={14} aria-hidden="true" className="shrink-0 text-fg-3" />
            <span className="truncate">{item.activity.text}</span>
          </p>
        </div>
        <span className="shrink-0 text-xs text-fg-3">
          <Elapsed from={item.startedAt} live />
        </span>
      </button>
    </li>
  );
}

/** What the orchestrator is doing when no agent is working. */
const IDLE_NOW_TEXT: Partial<Record<RunPhase, string>> = {
  analyzing: "Reading your request.",
  planning: "The planner is breaking the request into tasks.",
  synthesizing: "Writing the final answer from the finished tasks.",
};

function NowList() {
  const { session, agentName } = useRunView();
  const items = useMemo(() => nowItems(session.views.agentActivity, session.views.taskBoard, agentName), [session.views.agentActivity, session.views.taskBoard, agentName]);
  const watching = session.liveEvents.length > 0;
  const idleText = IDLE_NOW_TEXT[session.views.ledger.phase] ?? "Waiting for the next task to start.";
  return (
    <Section title="Now" description={items.length === 0 ? idleText : undefined}>
      {items.length > 0 && (
        <Card className="p-1">
          <ul className="flex flex-col">
            {items.map((item) => (
              <NowRow key={item.dispatchId} item={item} />
            ))}
          </ul>
        </Card>
      )}
      {!watching && items.length > 0 && (
        <p className="mt-2 text-xs text-fg-3">Live steps (tool calls, thinking) appear only for runs you started in this tab. Progress still updates as tasks finish.</p>
      )}
    </Section>
  );
}

function TaskRow({ card }: { card: TaskCard }) {
  const { session, status, selectTask, selectedTaskId, agentName } = useRunView();
  const task = session.values.tasks?.[card.id];
  const cardStatus = cardTone(session.views.taskBoard, card, task, status);
  const duration = card.startedAt && card.finishedAt ? formatDuration(Date.parse(card.finishedAt) - Date.parse(card.startedAt)) : null;
  return (
    <li>
      <button
        type="button"
        onClick={() => selectTask(card.id)}
        aria-current={selectedTaskId === card.id ? "true" : undefined}
        className={cx("ax-press grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 rounded-md px-3 py-2.5 text-left hover:bg-hover", selectedTaskId === card.id && "bg-selected")}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={cx("truncate text-sm font-medium text-fg", (card.status === "canceled" || cardStatus.label === "Replaced") && "text-fg-3 line-through decoration-fg-3")}>
            {card.title}
          </span>
          <OriginMark origin={card.originKind} size={13} />
        </span>
        <StatusText tone={cardStatus} className="justify-self-end" />
        <span className="flex min-w-0 items-center gap-2 text-xs text-fg-3">
          <span className="truncate">{agentName(card.agentId)}</span>
          {card.tier && <TierText tier={card.tier} className="text-xs" />}
          {card.attempt > 1 && <span>Attempt {card.attempt}</span>}
        </span>
        <span className="justify-self-end text-xs text-fg-3 tabular">{duration}</span>
      </button>
    </li>
  );
}

function TaskGroups({ collapsedByDefault }: { collapsedByDefault: boolean }) {
  const { session, status } = useRunView();
  const groups = useMemo(() => overviewGroups(session.views.taskBoard, session.values.tasks, status), [session.views.taskBoard, session.values.tasks, status]);
  if (groups.length === 0) return null;
  const total = session.views.taskBoard.order.length;
  const content = (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <Disclosure
          key={group.id}
          defaultOpen={group.defaultOpen}
          summary={
            <span className="flex items-center gap-2">
              {group.label}
              <span className="tabular text-xs font-normal text-fg-3">{group.cards.length}</span>
            </span>
          }
        >
          <ul className="mt-1 flex flex-col">
            {group.cards.map((card) => (
              <TaskRow key={card.id} card={card} />
            ))}
          </ul>
        </Disclosure>
      ))}
    </div>
  );
  if (collapsedByDefault) {
    return (
      <Card className="px-4 py-3">
        <Disclosure summary={<span className="text-base font-semibold">Tasks ({total})</span>}>
          <div className="pt-3">{content}</div>
        </Disclosure>
      </Card>
    );
  }
  return (
    <Section title="Tasks">
      <Card className="px-3 py-3">{content}</Card>
    </Section>
  );
}

function AdaptationItem({ item }: { item: Adaptation }) {
  const { selectTask, taskTitle } = useRunView();
  const itemTone = tone(humanizeKey(item.kind), item.family);
  return (
    <li className="flex gap-3">
      <StatusIcon tone={itemTone} size={16} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{item.title}</p>
        {item.detail && <p className="mt-0.5 text-sm leading-relaxed text-fg-2">{item.detail}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3">
          {item.wave !== null && item.wave > 0 && <span>Wave {item.wave}</span>}
          {item.diff && <span>{describeCounts(item.diff)}</span>}
          {item.taskIds.slice(0, 3).map((id) => (
            <TaskLink key={id} id={id} title={taskTitle(id)} onSelect={selectTask} className="text-xs" />
          ))}
        </div>
      </div>
    </li>
  );
}

function Adaptations() {
  const { session, taskTitle } = useRunView();
  const items = useMemo(() => narrateAdaptations(session.values.events ?? [], taskTitle), [session.values.events, taskTitle]);
  if (items.length === 0) return null;
  return (
    <Section title="How the plan adapted" description={`${pluralize(items.length, "change")} while the run was working.`}>
      <Card className="px-5 py-4">
        <ol className="flex flex-col gap-4">
          {items.map((item) => (
            <AdaptationItem key={item.id} item={item} />
          ))}
        </ol>
      </Card>
    </Section>
  );
}

function RequestDetails() {
  const { session } = useRunView();
  const intent = session.values.intent;
  const clarifications = session.values.input?.clarifications ?? [];
  if (!intent) return null;
  return (
    <Card className="px-4 py-3">
      <Disclosure summary={<span className="text-base font-semibold">How the request was understood</span>}>
        <div className="flex flex-col gap-4 pt-3 pb-1">
          <p className="max-w-[72ch] text-sm leading-relaxed text-fg">{intent.goal}</p>
          <KeyValues
            items={[
              ["Kind of request", humanizeKey(intent.intentType)],
              ["Complexity", humanizeKey(intent.complexity)],
              ["Approach", intent.path === "direct" ? "One agent answers directly" : "Planned as several tasks"],
              ["Deliverable", `${intent.deliverable.format} (${intent.deliverable.length}, for ${intent.deliverable.audience})`],
              ...(intent.constraints.length ? ([["Constraints", intent.constraints.join("; ")]] as [string, string][]) : []),
            ]}
          />
          {clarifications.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-fg">Your answers</h3>
              <dl className="mt-2 flex flex-col gap-2 text-sm">
                {clarifications.map((item, index) => (
                  <div key={index}>
                    <dt className="text-fg-2">{item.question}</dt>
                    <dd className="text-fg">{item.answer || "No answer (use best judgment)"}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      </Disclosure>
    </Card>
  );
}

export function OverviewTab() {
  const { session, status, counts } = useRunView();
  const { views, values, interrupts } = session;
  const final = values.final ?? null;
  const progress = useMemo(
    () =>
      deriveProgress({
        phase: views.ledger.phase,
        status,
        interruptKind: interrupts[0]?.value.kind ?? null,
        hasIntent: Boolean(values.intent),
        tasks: counts,
        wave: views.ledger.wave,
        hasFinal: final !== null,
      }),
    [views.ledger.phase, views.ledger.wave, status, interrupts, values.intent, counts, final],
  );

  return (
    <div className="flex flex-col gap-8">
      <ProgressRail steps={progress.steps} executeRatio={progress.executeRatio} />
      {final && <AnswerView final={final} />}
      {status === "running" && <NowList />}
      <TaskGroups collapsedByDefault={final !== null} />
      <Adaptations />
      <RequestDetails />
    </div>
  );
}
