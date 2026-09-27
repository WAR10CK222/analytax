import { useMemo, useState } from "react";
import { useCatalogContext } from "../../../app/catalog";
import { SegmentedControl } from "../../../components/ui/Form";
import { StatusIcon } from "../../../components/ui/Status";
import { Card, KeyValues, Section, StatTile } from "../../../components/ui/Surface";
import { useNow } from "../../../hooks/useNow";
import { cx } from "../../../lib/cx";
import { elapsedMs, formatClock, formatCount, formatDateTime, formatTokens } from "../../../lib/format";
import { TIER_LABEL, tone } from "../../../lib/status";
import { describeRunToolServers } from "../../../view-models/mcp";
import { isActiveStatus } from "../../../view-models/run-status";
import { costCell, guardTrips, liveUsage, orchestrationCounters, selectKpis, usageRows, waveBars } from "../../../view-models/usage";
import { useRunView } from "../run-context";

function KpiRow() {
  const { session, status } = useRunView();
  const { views } = session;
  const live = useNow(1000, isActiveStatus(status) && views.metrics.durationMs === null);
  const kpis = selectKpis({
    metrics: views.metrics,
    live: liveUsage(views.agentActivity),
    elapsedMs: views.ledger.startedAt ? elapsedMs(views.ledger.startedAt, live) : null,
  });
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {kpis.map((kpi) => (
        <StatTile key={kpi.id} label={kpi.label} value={kpi.value} detail={kpi.detail} />
      ))}
    </div>
  );
}

function UsageTable() {
  const { session } = useRunView();
  const [by, setBy] = useState<"model" | "tier">("model");
  const rows = useMemo(() => usageRows(by === "model" ? session.views.metrics.byModel : session.views.metrics.byTier), [by, session.views.metrics]);
  return (
    <Section
      title="Where the tokens went"
      level={3}
      actions={
        <SegmentedControl
          size="sm"
          label="Group by"
          value={by}
          onValueChange={setBy}
          options={[
            { value: "model", label: "By model" },
            { value: "tier", label: "By tier" },
          ]}
        />
      }
    >
      <Card className="overflow-x-auto">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-fg-3">No model calls yet.</p>
        ) : (
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-fg-3">
                <th scope="col" className="px-4 py-2.5 font-medium">
                  {by === "model" ? "Model" : "Tier"}
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  Calls
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  Input
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  Output
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  Thinking
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  Cached
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  Share
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody className="tabular">
              {rows.map((row) => (
                <tr key={row.key} className="border-b border-line last:border-b-0">
                  <th scope="row" className="px-4 py-2.5 text-left font-medium text-fg">
                    {by === "tier" ? (TIER_LABEL[row.key as keyof typeof TIER_LABEL] ?? row.key) : <span className="font-mono text-[13px]">{row.key}</span>}
                  </th>
                  <td className="px-4 py-2.5 text-right text-fg-2">{formatCount(row.usage.modelCalls, "0")}</td>
                  <td className="px-4 py-2.5 text-right text-fg-2">{formatTokens(row.usage.inputTokens, "0")}</td>
                  <td className="px-4 py-2.5 text-right text-fg-2">{formatTokens(row.usage.outputTokens, "0")}</td>
                  <td className="px-4 py-2.5 text-right text-fg-2">{formatTokens(row.usage.reasoningTokens, "0")}</td>
                  <td className="px-4 py-2.5 text-right text-fg-2">{formatTokens(row.usage.cachedTokens, "0")}</td>
                  <td className="px-4 py-2.5 text-right text-fg-2">{Math.round(row.share * 100)}%</td>
                  <td className="px-4 py-2.5 text-right text-fg-2">{costCell(row.usage).text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Section>
  );
}

/** Horizontal bars with direct labels, so values never hide behind a tooltip; the table below is the exact view. */
function WaveChart() {
  const { session } = useRunView();
  const bars = useMemo(() => waveBars(session.views.metrics.waves), [session.views.metrics.waves]);
  const [showTable, setShowTable] = useState(false);
  if (bars.length === 0) return null;
  return (
    <Section
      title="Wave durations"
      description="Each wave runs every ready task in parallel. Waves where no task finished are marked."
      level={3}
      actions={
        <SegmentedControl
          size="sm"
          label="Display"
          value={showTable ? "table" : "chart"}
          onValueChange={(next) => setShowTable(next === "table")}
          options={[
            { value: "chart", label: "Chart" },
            { value: "table", label: "Table" },
          ]}
        />
      }
    >
      <Card className="px-4 py-4">
        {showTable ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-3">
                <th scope="col" className="pb-2 font-medium">
                  Wave
                </th>
                <th scope="col" className="pb-2 text-right font-medium">
                  Duration
                </th>
                <th scope="col" className="pb-2 text-right font-medium">
                  Results
                </th>
                <th scope="col" className="pb-2 text-right font-medium">
                  Progress
                </th>
              </tr>
            </thead>
            <tbody className="tabular">
              {bars.map((bar) => (
                <tr key={bar.wave} className="border-t border-line">
                  <th scope="row" className="py-2 text-left font-medium">
                    {bar.wave}
                  </th>
                  <td className="py-2 text-right text-fg-2">{bar.label}</td>
                  <td className="py-2 text-right text-fg-2">{bar.reports}</td>
                  <td className="py-2 text-right text-fg-2">{bar.stalled ? "None" : "Yes"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <ol className="flex flex-col gap-2" aria-label="Wave durations">
            {bars.map((bar) => (
              <li key={bar.wave} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-3 text-sm">
                <span className="text-fg-2">Wave {bar.wave}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={cx("h-3 rounded-r-[4px]", bar.stalled ? "bg-attention/60" : "bg-fg-3")}
                    style={{ width: `${Math.max(bar.ratio * 78, 1.5)}%` }}
                    aria-hidden="true"
                  />
                  <span className="tabular shrink-0 text-xs text-fg-2">
                    {bar.label}
                    {bar.stalled && ", no progress"}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </Section>
  );
}

function Orchestration() {
  const { session } = useRunView();
  const { metrics, ledger } = session.views;
  const groups = useMemo(() => orchestrationCounters(metrics, ledger), [metrics, ledger]);
  const trips = guardTrips(ledger);
  return (
    <Section title="Orchestration" description="How much recovery and replanning this run needed." level={3}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {groups.map((group) => (
          <Card key={group.title} className="px-4 py-3.5">
            <h4 className="text-sm font-medium text-fg">{group.title}</h4>
            <dl className="mt-2.5 flex flex-col gap-1.5">
              {group.items.map((item) => (
                <div key={item.label} className="flex items-baseline justify-between gap-3 text-sm">
                  <dt className="text-fg-2">{item.label}</dt>
                  <dd className="tabular flex items-center gap-1.5 font-medium text-fg">
                    {item.family && <StatusIcon tone={tone(item.label, item.family)} size={12} />}
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        ))}
      </div>
      {trips.length > 0 && (
        <Card className="mt-3 px-4 py-3.5">
          <h4 className="text-sm font-medium text-fg">Safety limits reached</h4>
          <ul className="mt-2.5 flex flex-col gap-2">
            {trips.map((trip, index) => (
              <li key={`${trip.guard}-${index}`} className="flex gap-3 text-sm">
                <StatusIcon tone={tone(trip.label, "attention")} size={14} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="font-medium text-fg">{trip.label}</span>
                  <span className="text-fg-2">: {trip.detail}</span>
                  <span className="ml-2 text-xs text-fg-3">{formatClock(trip.ts)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Section>
  );
}

function RunSettingsUsed() {
  const { session } = useRunView();
  const { catalog } = useCatalogContext();
  const { ledger } = session.views;
  if (!ledger.hitl) return null;
  const onOff = (value: boolean) => (value ? "On" : "Off");
  const toolServers = describeRunToolServers(ledger.toolServers);
  return (
    <Section title="Settings used" level={3}>
      <Card className="px-4 py-3.5">
        <KeyValues
          items={[
            ["Ask clarifying questions", onOff(ledger.hitl.clarify)],
            ["Approve the plan first", onOff(ledger.hitl.approvePlan)],
            ["Escalate stuck tasks", onOff(ledger.hitl.humanReview)],
            ["Parallel agents", ledger.maxConcurrency !== null ? String(ledger.maxConcurrency) : "Default"],
            ["Deadline", ledger.deadlineAt ? formatDateTime(ledger.deadlineAt) : "None"],
            ["Models", catalog?.mode === "offline" ? "Offline demo (stand-in models)" : "Live Gemini models"],
            ...(toolServers ? [["Tool servers", toolServers] as [string, string]] : []),
          ]}
        />
      </Card>
    </Section>
  );
}

export function UsageTab() {
  return (
    <div className="flex flex-col gap-8">
      <KpiRow />
      <UsageTable />
      <WaveChart />
      <Orchestration />
      <RunSettingsUsed />
    </div>
  );
}
