import { Tabs } from "@base-ui/react/tabs";
import { formatToolName, isWaiting, unwrapToolOutput, type Task, type TaskCard, type TaskResult } from "@analytax/contracts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MarkdownView } from "../../../components/Markdown";
import { IconButton } from "../../../components/ui/Button";
import { DialogTitle, Sheet } from "../../../components/ui/Dialog";
import { Disclosure } from "../../../components/ui/Disclosure";
import { IconClose, IconExternal, IconFile } from "../../../components/ui/icons";
import { StatusBadge, StatusIcon, StatusText } from "../../../components/ui/Status";
import { Callout, EmptyState, KeyValues } from "../../../components/ui/Surface";
import { TaskLink } from "../../../components/ui/TaskLink";
import { Elapsed } from "../../../components/ui/time";
import { cx } from "../../../lib/cx";
import { formatCost, formatDateTime, formatDuration, formatPercent, formatScore, formatTokens, pluralize, usageTokens } from "../../../lib/format";
import { DISPATCH_TONE, ORIGIN_LABEL, TASK_STATUS_TONE, TIER_LABEL, decisionTone, humanizeKey, tone } from "../../../lib/status";
import { mergeAttempts } from "../../../view-models/attempts";
import { costCell } from "../../../view-models/usage";
import { dispatchesForTask } from "../../../view-models/dispatch";
import { cardTone } from "../../../view-models/tasks";
import { useRunView } from "../run-context";

type InspectorTab = "overview" | "live" | "result" | "attempts";

function Block({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Bullets({ items, empty }: { items: readonly string[]; empty?: string }) {
  if (items.length === 0) return empty ? <p className="text-sm text-fg-3">{empty}</p> : null;
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-fg marker:text-fg-3">
      {items.map((item, index) => (
        <li key={index} className="break-words">
          {item}
        </li>
      ))}
    </ul>
  );
}

function TaskLinks({ ids }: { ids: readonly string[] }) {
  const { session, selectTask, taskTitle } = useRunView();
  if (ids.length === 0) return <span className="text-fg-3">None</span>;
  return (
    <span className="flex flex-col gap-1">
      {ids.map((id) => {
        const status = session.values.tasks?.[id]?.status ?? session.views.taskBoard.cards[id]?.status;
        return (
          <span key={id} className="flex items-center gap-1.5">
            {status && <StatusIcon tone={TASK_STATUS_TONE[status]} size={13} />}
            <TaskLink id={id} title={taskTitle(id)} onSelect={selectTask} />
          </span>
        );
      })}
    </span>
  );
}

function OverviewSection({ task, card }: { task: Task | undefined; card: TaskCard | undefined }) {
  const { agentName } = useRunView();
  const tier = task?.currentTier ?? card?.tier ?? null;
  const statusReason = task?.statusReason ?? card?.statusReason ?? null;
  const attempts = task?.attempt ?? card?.attempt ?? 0;
  const extra =
    task && (task.infraRetries > 0 || task.blockCount > 0)
      ? ` (${[task.infraRetries > 0 && pluralize(task.infraRetries, "retry after an error", "retries after errors"), task.blockCount > 0 && pluralize(task.blockCount, "block")].filter(Boolean).join(", ")})`
      : "";
  const origin = task?.origin.kind ?? card?.originKind;
  return (
    <div className="flex flex-col gap-6">
      {statusReason && statusReason !== "superseded" && <Callout title={statusReason} />}
      <KeyValues
        items={[
          ["Agent", agentName(task?.agentId ?? card?.agentId ?? "")],
          ["Capability", humanizeKey(task?.capability ?? card?.capability ?? "unknown")],
          ["Complexity", humanizeKey(task?.complexity ?? card?.complexity ?? "unknown")],
          ["Model tier", tier ? `${TIER_LABEL[tier]}${task?.tierOverride ? ` (set to ${TIER_LABEL[task.tierOverride]})` : ""}` : "Not started"],
          ["Attempts", `${attempts}${extra}`],
          ["Waits for", <TaskLinks key="deps" ids={task?.dependsOn ?? card?.dependsOn ?? []} />],
        ]}
      />
      <Block title="Instructions">
        <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg">{task?.instructions ?? card?.instructions ?? "None"}</p>
      </Block>
      <Block title="Done when">
        <Bullets items={task?.acceptanceCriteria ?? card?.acceptanceCriteria ?? []} empty="No acceptance criteria." />
        {task && task.checks.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {task.checks.map((check, index) => (
              <li key={index} className="rounded-full bg-sunken px-2 py-0.5 text-xs text-fg-2">
                {humanizeKey(check.kind)}: {check.value}
              </li>
            ))}
          </ul>
        )}
      </Block>
      {task?.pendingFeedback && (
        <Block title="Feedback for the next attempt">
          <Callout family="attention" title="From the reviewer">
            <span className="whitespace-pre-wrap">{task.pendingFeedback}</span>
          </Callout>
        </Block>
      )}
      {task && (
        <Disclosure summary="More details">
          <div className="pt-3">
            <KeyValues
              items={[
                ["If an input fails", task.dependencyPolicy === "best_effort" ? "Run anyway with what succeeded" : "Do not run"],
                ["Extra context from", <TaskLinks key="ctx" ids={task.contextFrom} />],
                ["Result review", humanizeKey(task.evaluation)],
                ["Critical to the answer", task.critical ? "Yes" : "No"],
                ["Agents tried", task.triedAgents.map(agentName).join(", ") || "None"],
                ["Origin", `${origin ? (ORIGIN_LABEL[origin]?.label ?? "Original plan") : "Original plan"}, plan version ${task.origin.planVersion}`],
                ...(task.origin.parentTaskId ? ([["Came from", <TaskLinks key="parent" ids={[task.origin.parentTaskId]} />]] as [string, ReactNode][]) : []),
                ...(task.revisionOf ? ([["Revision of", <TaskLinks key="rev" ids={[task.revisionOf]} />]] as [string, ReactNode][]) : []),
                ...(task.supersededBy.length ? ([["Replaced by", <TaskLinks key="sup" ids={task.supersededBy} />]] as [string, ReactNode][]) : []),
                ...(task.staleInputs ? ([["Inputs changed", "An input was revised after this task finished"]] as [string, ReactNode][]) : []),
                ["Last updated", formatDateTime(task.updatedAt)],
              ]}
            />
            {task.notes.length > 0 && (
              <div className="mt-4">
                <Block title="Notes">
                  <Bullets items={task.notes} />
                </Block>
              </div>
            )}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

function LiveSection({ taskId }: { taskId: string }) {
  const { session, status } = useRunView();
  const dispatches = useMemo(() => dispatchesForTask(session.views.agentActivity, taskId), [session.views.agentActivity, taskId]);
  if (dispatches.length === 0) {
    return <EmptyState title="No agent steps" hint="Tool calls and thinking show here for runs watched live in this tab." />;
  }
  return (
    <ol className="flex flex-col gap-5">
      {dispatches.map((dispatch) => {
        const active = dispatch.status !== "done" && status === "running";
        const dispatchTone = dispatch.status !== "done" && status === "stopped" ? tone("Stopped", "neutral", "stopped") : DISPATCH_TONE[dispatch.status];
        return (
          <li key={dispatch.dispatchId} className="flex flex-col gap-3 rounded-md border border-line px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <StatusBadge tone={dispatchTone} />
              {dispatch.attempt !== null && <span className="text-sm font-medium">Attempt {dispatch.attempt}</span>}
              <span className="text-xs text-fg-3">
                <Elapsed from={dispatch.startedAt ?? dispatch.queuedAt} to={dispatch.finishedAt} live={active} />
              </span>
            </div>
            <p className="text-xs text-fg-3">
              {dispatch.tier ? TIER_LABEL[dispatch.tier] : "Tier pending"}
              {dispatch.model ? `, ${dispatch.model}` : ""}, {pluralize(dispatch.modelCalls, "model call")}, {formatTokens(usageTokens(dispatch.usage), "0")} tokens
              {dispatch.usage.reasoningTokens > 0 ? ` (${formatTokens(dispatch.usage.reasoningTokens)} thinking)` : ""}
            </p>
            {dispatch.unavailableToolServers.length > 0 && (
              <p className="text-xs text-attention">Worked without {dispatch.unavailableToolServers.join(", ")} tools: the server was unavailable for this attempt.</p>
            )}
            {dispatch.tools.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-fg-3">Tools</h4>
                <ul className="mt-1.5 flex flex-col gap-1.5">
                  {dispatch.tools.slice(-8).map((tool, index) => (
                    <li key={tool.callId ?? `${tool.tool}-${index}`} className="flex items-start gap-2 text-sm">
                      <StatusIcon tone={tool.ok === null ? tone("Running", "running") : tool.ok ? tone("Done", "success") : tone("Failed", "danger")} size={13} className="mt-0.5" />
                      <span className="min-w-0 flex-1">
                        <span className="font-mono text-[13px] text-fg">{formatToolName(tool.tool)}</span>
                        {tool.durationMs !== null && <span className="ml-2 text-xs text-fg-3">{formatDuration(tool.durationMs)}</span>}
                        {(tool.preview ?? tool.args) && <span className="mt-0.5 line-clamp-2 block text-xs break-all text-fg-2">{tool.preview ? unwrapToolOutput(tool.preview) : tool.args}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {dispatch.skills.length > 0 && (
              <p className="text-xs text-fg-2">
                <span className="text-fg-3">Skills used: </span>
                {dispatch.skills.join(", ")}
              </p>
            )}
            {dispatch.thoughts.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-fg-3">Thinking</h4>
                <ul className="mt-1.5 flex flex-col gap-2">
                  {dispatch.thoughts.slice(-3).map((thought, index) => (
                    <li key={index} className="border-l-2 border-line-strong pl-3 text-sm leading-relaxed text-fg-2">
                      {thought}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {dispatch.error && <Callout family="danger" title="Error">{dispatch.error}</Callout>}
          </li>
        );
      })}
    </ol>
  );
}

function ResultSection({ result }: { result: TaskResult | undefined }) {
  if (!result) return <EmptyState title="No accepted result yet" hint="The result shows here once a reviewer accepts an attempt." />;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-fg-3">
        Confidence {formatPercent(result.confidence)}, score {formatScore(result.score)}, reviewed by {result.evaluatedBy === "llm" ? "a model" : result.evaluatedBy === "rules" ? "rules" : "nobody (skipped)"}
        {result.degraded && ", accepted with gaps"}
      </p>
      <Block title="Summary">
        <p className="text-sm leading-relaxed text-fg">{result.summary}</p>
      </Block>
      {result.keyFindings.length > 0 && (
        <Block title="Key findings">
          <Bullets items={result.keyFindings} />
        </Block>
      )}
      {result.sources.length > 0 && (
        <Block title="Sources">
          <ol className="flex flex-col gap-1.5 text-sm">
            {result.sources.map((source, index) => (
              <li key={index} className="flex gap-2">
                <span className="tabular w-5 shrink-0 text-right text-fg-3">{index + 1}</span>
                {source.url ? (
                  <a href={source.url} target="_blank" rel="noreferrer noopener" className="min-w-0 break-words text-fg hover:underline">
                    {source.title || source.url}
                    <IconExternal size={12} aria-hidden="true" className="ml-1 inline text-fg-3" />
                  </a>
                ) : (
                  <span className="min-w-0 break-words">{source.title}</span>
                )}
              </li>
            ))}
          </ol>
        </Block>
      )}
      {result.assumptions.length > 0 && (
        <Block title="Assumptions">
          <Bullets items={result.assumptions} />
        </Block>
      )}
      {result.openQuestions.length > 0 && (
        <Block title="Open questions">
          <Bullets items={result.openQuestions} />
        </Block>
      )}
      <Block title="Full output" aside={<span className="text-xs text-fg-3">{result.outputChars.toLocaleString()} characters</span>}>
        {result.output !== null ? (
          <div className="scroll-thin max-h-[32rem] overflow-y-auto rounded-md bg-sunken px-4 py-3">
            <MarkdownView>{result.output}</MarkdownView>
          </div>
        ) : result.outputRef ? (
          <p className="flex items-start gap-2 rounded-md border border-dashed border-line-strong px-3 py-2.5 text-sm text-fg-2">
            <IconFile size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>
              Stored as an artifact (<span className="font-mono text-xs">{result.outputRef.key}</span>, {result.outputRef.mime},{" "}
              {result.outputRef.bytes.toLocaleString()} bytes).
            </span>
          </p>
        ) : (
          <p className="text-sm text-fg-3">No output.</p>
        )}
      </Block>
    </div>
  );
}

function AttemptsSection({ task, taskId }: { task: Task | undefined; taskId: string }) {
  const { session, agentName } = useRunView();
  const attempts = useMemo(() => mergeAttempts(task, session.values.events, taskId), [task, session.values.events, taskId]);
  if (attempts.length === 0) return <EmptyState title="No attempts yet" hint="Each attempt and its review shows here." />;
  return (
    <ol className="flex flex-col gap-4">
      {attempts.map((attempt) => {
        const record = attempt.records.at(-1) ?? null;
        const evaluation = attempt.evaluation;
        const decision = decisionTone(record?.decision ?? evaluation?.decision ?? (evaluation?.error ? "error" : null));
        return (
          <li key={attempt.dispatchId} className="flex flex-col gap-2.5 rounded-md border border-line px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-sm font-semibold">Attempt {attempt.attempt}</span>
              <StatusBadge tone={decision} />
              {record && <span className="text-xs text-fg-3">{agentName(record.agentId)}, {TIER_LABEL[record.tier]}</span>}
              {(record?.score ?? evaluation?.score) != null && <span className="text-xs text-fg-3 tabular">Score {formatScore(record?.score ?? evaluation?.score)}</span>}
            </div>
            {evaluation && (
              <p className="text-xs text-fg-3">
                Reviewed by {evaluation.evaluatedBy === "llm" ? "a model" : evaluation.evaluatedBy === "rules" ? "rules" : "nobody"}
                {evaluation.outcomeStatus ? `, agent reported ${decisionTone(evaluation.outcomeStatus).label.toLowerCase()}` : ""}, {evaluation.model},{" "}
                {formatTokens(usageTokens(evaluation.usage), "0")} tokens, {costCell(evaluation.usage).priced ? formatCost(evaluation.usage.costUsd) : "not priced"}, {formatDuration(evaluation.durationMs)}
              </p>
            )}
            {record?.feedback && <p className="text-sm whitespace-pre-wrap text-fg">{record.feedback}</p>}
            {evaluation && evaluation.unmetCriteria.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-fg-3">Not met</h4>
                <Bullets items={evaluation.unmetCriteria} />
              </div>
            )}
            {(record?.issues.length ?? 0) + (evaluation?.issues.length ?? 0) > 0 && (
              <div>
                <h4 className="text-xs font-medium text-fg-3">Issues</h4>
                <Bullets items={[...new Set([...(record?.issues ?? []), ...(evaluation?.issues ?? [])])]} />
              </div>
            )}
            {(record?.errorSignature || evaluation?.error) && (
              <p className="font-mono text-xs break-all text-danger">{record?.errorSignature ?? evaluation?.error}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function InspectorContent({ taskId, onClose, modal }: { taskId: string; onClose: () => void; modal: boolean }) {
  const { session, status } = useRunView();
  const task = session.values.tasks?.[taskId];
  const card = session.views.taskBoard.cards[taskId];
  const result = session.values.results?.[taskId];
  const titleRef = useRef<HTMLHeadingElement>(null);
  const hasLive = useMemo(() => dispatchesForTask(session.views.agentActivity, taskId).length > 0, [session.views.agentActivity, taskId]);
  const initialTab: InspectorTab = result ? "result" : card?.status === "working" && hasLive ? "live" : "overview";
  const [tab, setTab] = useState<InspectorTab>(initialTab);
  useEffect(() => {
    setTab(initialTab);
    if (!modal) titleRef.current?.focus({ preventScroll: true });
    // Reset only when the task changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const statusTone = card ? cardTone(session.views.taskBoard, card, task, status) : task ? TASK_STATUS_TONE[task.status] : null;
  const title = task?.title ?? card?.title ?? taskId;
  const waiting = card ? isWaiting(session.views.taskBoard, card) : false;
  const Title = modal ? DialogTitle : "h2";

  const tabs: { id: InspectorTab; label: string; count?: number }[] = [
    { id: "overview", label: "Overview" },
    ...(hasLive ? [{ id: "live" as const, label: "Steps" }] : []),
    { id: "result", label: "Result" },
    { id: "attempts", label: "Attempts", count: task?.attempt ?? card?.attempt ?? 0 },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3 border-b border-line px-5 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <Title ref={titleRef} tabIndex={-1} className="text-md leading-snug font-semibold text-fg outline-none">
            {title}
          </Title>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {statusTone && <StatusBadge tone={statusTone} />}
            {waiting && statusTone?.label !== "Waiting" && <StatusText tone={tone("Waiting for inputs", "neutral", "waiting")} className="text-xs" />}
          </div>
        </div>
        <IconButton label="Close task details" icon={<IconClose size={16} aria-hidden="true" />} onClick={onClose} className="-mt-1 -mr-2" />
      </div>
      {!task && !card ? (
        <EmptyState title="This task is not in the plan yet" hint="It may belong to a newer plan version. It appears once the orchestrator commits it." />
      ) : (
        <Tabs.Root value={tab} onValueChange={(next) => setTab(next as InspectorTab)} className="flex min-h-0 flex-1 flex-col">
          <Tabs.List aria-label="Task details" className="relative flex gap-1 border-b border-line px-3">
            {tabs.map((item) => (
              <Tabs.Tab
                key={item.id}
                value={item.id}
                className="flex h-10 items-center gap-1.5 px-2 text-sm font-medium text-fg-2 outline-none hover:text-fg data-[selected]:text-fg focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-fg"
              >
                {item.label}
                {item.count ? <span className="tabular text-xs font-normal text-fg-3">{item.count}</span> : null}
              </Tabs.Tab>
            ))}
            <Tabs.Indicator className="absolute bottom-0 left-[var(--active-tab-left)] h-0.5 w-[var(--active-tab-width)] rounded-full bg-fg transition-[left,width] duration-200" />
          </Tabs.List>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-5">
            <Tabs.Panel value="overview">
              <OverviewSection task={task} card={card} />
            </Tabs.Panel>
            {hasLive && (
              <Tabs.Panel value="live">
                <LiveSection taskId={taskId} />
              </Tabs.Panel>
            )}
            <Tabs.Panel value="result">
              <ResultSection result={result} />
            </Tabs.Panel>
            <Tabs.Panel value="attempts">
              <AttemptsSection task={task} taskId={taskId} />
            </Tabs.Panel>
          </div>
        </Tabs.Root>
      )}
    </div>
  );
}

/** Task details: an inline column on very wide screens, a modal sheet otherwise. `&task=` deep-links here. */
export function TaskInspector({ inline }: { inline: boolean }) {
  const { selectedTaskId, selectTask } = useRunView();
  const [shownId, setShownId] = useState(selectedTaskId);
  useEffect(() => {
    if (selectedTaskId) setShownId(selectedTaskId);
  }, [selectedTaskId]);
  const asideRef = useRef<HTMLElement>(null);

  // Esc closes the inline column when focus is inside it (modal sheets handle Esc themselves).
  useEffect(() => {
    if (!inline || !selectedTaskId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && asideRef.current?.contains(document.activeElement)) selectTask(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inline, selectedTaskId, selectTask]);

  if (inline) {
    if (!selectedTaskId) return null;
    return (
      <aside ref={asideRef} aria-label="Task details" className="sticky top-0 flex h-dvh w-[440px] shrink-0 flex-col border-l border-line bg-surface">
        <InspectorContent taskId={selectedTaskId} onClose={() => selectTask(null)} modal={false} />
      </aside>
    );
  }
  const id = selectedTaskId ?? shownId;
  return (
    <Sheet open={selectedTaskId !== null} onOpenChange={(open) => !open && selectTask(null)} side="right" label="Task details" className={cx("w-full sm:w-[min(30rem,100vw)]")}>
      {id && <InspectorContent taskId={id} onClose={() => selectTask(null)} modal />}
    </Sheet>
  );
}
