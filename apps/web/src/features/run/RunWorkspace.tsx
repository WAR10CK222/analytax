import { Tabs } from "@base-ui/react/tabs";
import { Activity, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCatalogContext } from "../../app/catalog";
import { useRunSession } from "../../app/session";
import { Callout } from "../../components/ui/Surface";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { fetchThreadPresence } from "../../lib/api";
import { errorMessage } from "../../lib/format";
import { runHistoryStore } from "../../lib/run-history";
import { RUN_TABS, navigate, useRoute, type RunTab } from "../../lib/url-state";
import { deriveRunStatus, isActiveStatus } from "../../view-models/run-status";
import { taskCounts, taskTitle } from "../../view-models/tasks";
import { ActivityTab } from "./activity/ActivityTab";
import { TaskInspector } from "./inspector/TaskInspector";
import { InterruptDialog } from "./interrupt/InterruptDialog";
import { OverviewTab } from "./overview/OverviewTab";
import { RunViewContext, type RunView } from "./run-context";
import { RunHeader } from "./RunHeader";
import { AttentionCallout, RunNotFound, RunSkeleton } from "./states";
import { UsageTab } from "./usage/UsageTab";

const PlanTab = lazy(() => import("./plan/PlanTab"));

function TabFallback() {
  return <div className="h-96 animate-pulse rounded-lg bg-sunken motion-reduce:animate-none" aria-label="Loading" />;
}

export function RunWorkspace() {
  const session = useRunSession();
  const route = useRoute();
  const { agentName } = useCatalogContext();
  const { views, values, interrupts, threadId } = session;
  const wideInspector = useMediaQuery("(min-width: 1440px)");

  const status = deriveRunStatus({
    phase: views.ledger.phase,
    finalStatus: views.ledger.finalStatus,
    pendingInterrupts: interrupts.length,
    isLoading: session.isLoading,
    threadStatus: session.threadStatus,
    starting: session.starting,
  });
  const counts = useMemo(() => taskCounts(views.taskBoard, values.tasks), [views.taskBoard, values.tasks]);
  const query = values.input?.query ?? views.ledger.query ?? session.startedQuery;

  // Runs from the list may be gone after an orchestrator restart (threads live in memory).
  const [presence, setPresence] = useState<"exists" | "missing" | "unknown">("unknown");
  const hasEvents = (values.events?.length ?? 0) > 0;
  useEffect(() => {
    if (!threadId || hasEvents || session.starting) return;
    const controller = new AbortController();
    void fetchThreadPresence(threadId, controller.signal).then((next) => {
      if (!controller.signal.aborted) setPresence(next);
    });
    return () => controller.abort();
  }, [threadId, hasEvents, session.starting]);

  // Keep the sidebar history in step with what this run is doing. Finished runs are dated by their last event, so
  // reopening one does not bump it to the top.
  const lastEventAt = views.timeline.entries.at(-1)?.ts ?? null;
  const activityAt = isActiveStatus(status) ? null : lastEventAt;
  useEffect(() => {
    if (!threadId) return;
    if (presence === "missing" && !hasEvents) runHistoryStore.upsert({ threadId, status: "missing" });
    // "idle" is a loading state, never an outcome: in a background tab the views wait for a frame before folding
    // the loaded events, and recording it then would label a finished run "Not started".
    else if ((hasEvents || session.starting) && status !== "idle") runHistoryStore.upsert({ threadId, query, status, activityAt });
  }, [threadId, query, status, activityAt, presence, hasEvents, session.starting]);

  useEffect(() => {
    document.title = query ? `${query.length > 60 ? `${query.slice(0, 57)}...` : query} · Analytax` : "Run · Analytax";
  }, [query]);

  // Tabs: visited panels stay mounted (hidden) so the graph viewport and filters survive switching.
  const tab: RunTab = route.tab;
  const [visited, setVisited] = useState<ReadonlySet<RunTab>>(() => new Set([tab]));
  useEffect(() => {
    setVisited((current) => (current.has(tab) ? current : new Set([...current, tab])));
  }, [tab]);
  useEffect(() => {
    // Warm the graph chunk while the reader looks at the overview.
    const handle = window.setTimeout(() => void import("./plan/PlanTab"), 1500);
    return () => window.clearTimeout(handle);
  }, []);

  // Inspector: `&task=` deep link. Inline column on very wide screens, modal sheet otherwise.
  const selectedTaskId = route.task;
  const selectTask = useCallback((taskId: string | null) => navigate({ task: taskId }, { replace: true }), []);
  const inspectorModalOpen = selectedTaskId !== null && !wideInspector;

  // Interrupt dialog: opens for each new question, but not on top of the modal inspector (the callout covers that).
  const interruptKey = interrupts.map((interrupt) => interrupt.id ?? interrupt.value.kind).join("|");
  const [dialogOpen, setDialogOpen] = useState(false);
  const lastKey = useRef("");
  useEffect(() => {
    if (!interruptKey) {
      setDialogOpen(false);
      lastKey.current = "";
      return;
    }
    if (interruptKey !== lastKey.current && !inspectorModalOpen) {
      lastKey.current = interruptKey;
      setDialogOpen(true);
    }
  }, [interruptKey, inspectorModalOpen]);

  const view = useMemo<RunView>(
    () => ({
      session,
      status,
      counts,
      query,
      selectedTaskId,
      selectTask,
      taskTitle: (id) => taskTitle(views.taskBoard, id),
      agentName,
      openInterrupts: () => {
        selectTask(null);
        setDialogOpen(true);
      },
    }),
    [session, status, counts, query, selectedTaskId, selectTask, views.taskBoard, agentName],
  );

  if (presence === "missing" && !hasEvents) return <RunNotFound />;
  if (!hasEvents && !session.starting && threadId && session.isThreadLoading) return <RunSkeleton />;

  const tabCounts: Partial<Record<RunTab, number>> = { plan: views.taskBoard.order.length, activity: views.timeline.entries.length };
  const panel = (id: RunTab, content: ReactNode) =>
    visited.has(id) ? (
      <Tabs.Panel value={id} keepMounted className="outline-none">
        <Activity mode={tab === id ? "visible" : "hidden"}>{content}</Activity>
      </Tabs.Panel>
    ) : null;
  const pending = interrupts[0];

  return (
    <RunViewContext.Provider value={view}>
      <Tabs.Root value={tab} onValueChange={(next) => navigate({ tab: next as RunTab }, { replace: true })} className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <RunHeader tabs={RUN_TABS} counts={tabCounts} />
          <div className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
            {pending && !dialogOpen && <AttentionCallout kind={pending.value.kind} onReview={view.openInterrupts} />}
            {views.ledger.error && (
              <Callout family="danger" role="alert" title="The run failed">
                {views.ledger.error}
              </Callout>
            )}
            {Boolean(session.error) && !views.ledger.error && (
              <Callout family="danger" role="alert" title="Lost the connection to this run">
                {errorMessage(session.error)}. The page keeps checking the server and catches up when it is back.
              </Callout>
            )}
            {panel("overview", <OverviewTab />)}
            {panel(
              "plan",
              <Suspense fallback={<TabFallback />}>
                <PlanTab />
              </Suspense>,
            )}
            {panel("activity", <ActivityTab />)}
            {panel("usage", <UsageTab />)}
          </div>
        </div>
        <TaskInspector inline={wideInspector} />
      </Tabs.Root>
      <InterruptDialog open={dialogOpen && pending !== undefined} onOpenChange={setDialogOpen} />
    </RunViewContext.Provider>
  );
}
