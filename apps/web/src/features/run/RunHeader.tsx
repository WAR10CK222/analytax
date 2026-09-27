import { Tabs } from "@base-ui/react/tabs";
import { useShell } from "../../app/shell-context";
import { Button, IconButton, iconButtonClass } from "../../components/ui/Button";
import { IconCode, IconCopy, IconExternal, IconLink, IconMore, IconRetry, IconSidebar, IconStop } from "../../components/ui/icons";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tooltip } from "../../components/ui/Overlay";
import { StatusBadge } from "../../components/ui/Status";
import { notify } from "../../components/ui/Toast";
import { Elapsed } from "../../components/ui/time";
import { traceExploreUrl } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { cx } from "../../lib/cx";
import { setDraft } from "../../lib/draft";
import { errorMessage, shortId } from "../../lib/format";
import { navigate, runLink, type RunTab } from "../../lib/url-state";
import { RUN_STATUS_TONE, isActiveStatus } from "../../view-models/run-status";
import { useRunView } from "./run-context";

const TAB_LABEL: Record<RunTab, string> = { overview: "Overview", plan: "Plan", activity: "Activity", usage: "Usage" };

export function RunHeader({ tabs, counts }: { tabs: readonly RunTab[]; counts: Partial<Record<RunTab, number>> }) {
  const { session, status, query, counts: taskCounts } = useRunView();
  const { actions, sidebarOpen } = useShell();
  const { views, values, threadId } = session;
  const active = isActiveStatus(status);
  const traceUrl = values.run?.traceId ? traceExploreUrl(values.run.traceId) : null;
  const planVersion = views.dag.version;

  const copy = async (text: string, what: string) => {
    const ok = await copyText(text);
    notify(ok ? `${what} copied` : `Could not copy the ${what.toLowerCase()}`, ok ? undefined : "Your browser blocked clipboard access.");
  };

  const runAgain = () => {
    const runOptions = values.runOptions ?? null;
    setDraft({ query: query ?? "", runOptions });
    actions.newRun();
  };

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur-md md:top-0">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-2 px-4 pt-4 sm:px-6 lg:px-8">
        <div className="flex items-start gap-3">
          {!sidebarOpen && (
            <Tooltip content="Show sidebar">
              <IconButton label="Show sidebar" icon={<IconSidebar size={18} aria-hidden="true" />} onClick={actions.toggleSidebar} className="-ml-1.5 max-md:hidden" />
            </Tooltip>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="line-clamp-2 text-lg font-semibold tracking-tight text-fg sm:line-clamp-1" title={query ?? undefined}>
              {query ?? "Loading run"}
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-fg-2" aria-live="polite">
              <StatusBadge tone={RUN_STATUS_TONE[status]} />
              {views.ledger.startedAt && (
                <span>
                  {/* A stopped run never records a finish time, so it ends at its last event. */}
                  <Elapsed from={views.ledger.startedAt} to={views.metrics.finishedAt ?? (active ? null : (views.timeline.entries.at(-1)?.ts ?? null))} live={active} />
                </span>
              )}
              {taskCounts.total > 0 && (
                <span className="tabular">
                  {taskCounts.done} of {taskCounts.total} tasks done
                </span>
              )}
              {planVersion > 1 && <span>Plan version {planVersion}</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {active && (
              <Button
                variant="secondary"
                size="md"
                icon={<IconStop size={14} weight="fill" aria-hidden="true" />}
                onClick={() => {
                  session.stop().catch((error: unknown) => notify("Could not stop the run", errorMessage(error)));
                }}
              >
                Stop
              </Button>
            )}
            <Menu>
              <MenuTrigger className={iconButtonClass("ghost", "md")} aria-label="More actions">
                <IconMore size={18} weight="bold" aria-hidden="true" />
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem icon={<IconRetry size={16} aria-hidden="true" />} onClick={runAgain} disabled={!query}>
                  Run again with changes
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={<IconLink size={16} aria-hidden="true" />} onClick={() => threadId && void copy(runLink(threadId), "Link")} disabled={!threadId}>
                  Copy link
                </MenuItem>
                <MenuItem icon={<IconCopy size={16} aria-hidden="true" />} onClick={() => threadId && void copy(threadId, "Thread ID")} disabled={!threadId}>
                  Copy thread ID
                </MenuItem>
                {traceUrl && (
                  <MenuItem icon={<IconExternal size={16} aria-hidden="true" />} onClick={() => window.open(traceUrl, "_blank", "noopener,noreferrer")}>
                    Open trace in Grafana
                  </MenuItem>
                )}
                <MenuSeparator />
                <MenuLabel>Developer</MenuLabel>
                <div className="flex items-center gap-2.5 px-2.5 pb-2 text-xs text-fg-3">
                  <IconCode size={14} aria-hidden="true" />
                  <span>
                    Thread {shortId(threadId, 8, "not created")}, {session.sdk === "react" ? "@langchain/react" : "legacy SDK"}
                  </span>
                </div>
              </MenuContent>
            </Menu>
          </div>
        </div>
        <Tabs.List aria-label="Run views" className="relative -mb-px flex gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <Tabs.Tab
              key={tab}
              value={tab}
              onClick={() => navigate({ tab }, { replace: true })}
              className="ax-press relative flex h-10 shrink-0 items-center gap-1.5 px-2.5 text-sm font-medium text-fg-2 outline-none hover:text-fg data-[selected]:text-fg focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-fg"
            >
              {TAB_LABEL[tab]}
              {counts[tab] !== undefined && counts[tab] > 0 && <span className="tabular text-xs font-normal text-fg-3">{counts[tab]}</span>}
            </Tabs.Tab>
          ))}
          <Tabs.Indicator className="absolute bottom-0 left-[var(--active-tab-left)] h-0.5 w-[var(--active-tab-width)] rounded-full bg-fg transition-[left,width] duration-200 ease-[var(--ease-out)]" />
        </Tabs.List>
      </div>
    </header>
  );
}
