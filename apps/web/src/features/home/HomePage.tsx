import type { HitlSettings } from "@analytax/contracts";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useCatalogContext } from "../../app/catalog";
import { useRunSession } from "../../app/session";
import { Button, buttonClass } from "../../components/ui/Button";
import { AutoTextarea } from "../../components/ui/Form";
import { IconOffline, IconPlay, IconRetry, IconSettings } from "../../components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/Overlay";
import { Callout, Kbd, Skeleton } from "../../components/ui/Surface";
import { API_URL } from "../../lib/api";
import { cx } from "../../lib/cx";
import { takeDraft } from "../../lib/draft";
import { EXAMPLE_PROMPTS } from "./examples";
import { serverSwitches, toRunMcpOptions } from "../../view-models/mcp";
import { RunSettingsForm, summarizeSettings, toDemoFaults, type FaultDraft, type RunSettingsValue } from "./RunSettings";

const FALLBACK_HITL: HitlSettings = { clarify: false, approvePlan: false, humanReview: false };
const FALLBACK_CONCURRENCY = 4;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function HomePage() {
  const ids = useId();
  const { catalog, error: catalogError, loading: catalogLoading, reload } = useCatalogContext();
  const session = useRunSession();
  const [draft] = useState(takeDraft);
  const [query, setQuery] = useState(draft?.query ?? "");
  const [override, setOverride] = useState<Partial<RunSettingsValue> | null>(() => {
    if (!draft?.runOptions) return null;
    const faults: FaultDraft[] = (draft.runOptions.demoFaults ?? []).map((fault, index) => ({
      key: index + 1,
      kind: fault.kind,
      agentId: fault.agentId ?? "",
      titleIncludes: fault.taskTitleIncludes ?? "",
      times: fault.times ?? 1,
    }));
    return {
      ...(draft.runOptions.hitl ? { hitl: { ...FALLBACK_HITL, ...draft.runOptions.hitl } } : {}),
      ...(draft.runOptions.maxConcurrency ? { maxConcurrency: draft.runOptions.maxConcurrency } : {}),
      faults,
      toolServersOff: draft.runOptions.mcp?.disabled ?? [],
    };
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    document.title = "New run · Analytax";
    textareaRef.current?.focus();
  }, []);

  const defaults = useMemo<RunSettingsValue>(
    () => ({
      hitl: catalog?.hitlDefaults ?? FALLBACK_HITL,
      maxConcurrency: Math.max(1, Math.min(16, catalog?.guards.maxConcurrency ?? FALLBACK_CONCURRENCY)),
      faults: [],
      toolServersOff: [],
    }),
    [catalog],
  );
  const toolServers = useMemo(
    () => serverSwitches(catalog?.mcp, (id) => catalog?.agents.find((agent) => agent.id === id)?.name ?? id),
    [catalog],
  );
  const settings: RunSettingsValue = { ...defaults, ...override };
  const maxLimit = Math.max(8, defaults.maxConcurrency * 2);
  const faultsEnabled = catalog?.faultsEnabled === true;
  const canRun = query.trim().length > 0 && !session.starting;

  const submit = () => {
    if (!canRun) return;
    const mcp = toRunMcpOptions(settings.toolServersOff, toolServers);
    void session.startRun(query.trim(), {
      hitl: settings.hitl,
      maxConcurrency: settings.maxConcurrency,
      demoFaults: faultsEnabled ? toDemoFaults(settings.faults) : [],
      ...(mcp ? { mcp } : {}),
    });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[44rem] flex-1 flex-col px-4 pt-[min(14vh,7rem)] pb-16 sm:px-6">
      <h1 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl sm:leading-[40px]">What should the agents work on?</h1>
      <p className="mt-2 max-w-[60ch] text-base text-fg-2">
        A planner splits your request into tasks, specialist agents research and write in parallel, and you get one answer.
      </p>

      {catalogError && (
        <Callout
          family="danger"
          role="alert"
          className="mt-6"
          title={`Can't reach the orchestrator at ${API_URL}`}
          actions={
            <Button size="sm" icon={<IconRetry size={14} aria-hidden="true" />} onClick={reload}>
              Retry
            </Button>
          }
        >
          Start it with <code className="font-mono text-[0.92em]">pnpm dev</code>, then retry.
        </Callout>
      )}

      {session.startError && (
        <Callout family="danger" role="alert" className="mt-6" title="The run could not start" actions={<Button size="sm" onClick={session.clearStartError}>Dismiss</Button>}>
          {session.startError}
        </Callout>
      )}

      <form onSubmit={onSubmit} className="mt-8">
        <div className="rounded-lg border border-line-strong bg-surface transition-[border-color,box-shadow] duration-150 focus-within:border-fg focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--ax-fg)_10%,transparent)]">
          <label htmlFor={`${ids}-query`} className="sr-only">
            Your request
          </label>
          <AutoTextarea
            id={`${ids}-query`}
            ref={textareaRef}
            rows={3}
            maxRows={14}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask something that needs research, analysis or several steps."
            className="border-0 bg-transparent px-4 pt-3.5 text-md leading-6 focus:border-0 focus:shadow-none"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 pt-1 pb-2.5">
            <Popover>
              <PopoverTrigger className={cx(buttonClass("ghost", "sm"), "max-w-full min-w-0")}>
                <IconSettings size={14} aria-hidden="true" />
                <span className="truncate">{catalogLoading && !catalog ? "Loading settings" : summarizeSettings(settings)}</span>
              </PopoverTrigger>
              <PopoverContent side="bottom" align="start">
                {catalogLoading && !catalog ? (
                  <div className="flex w-80 flex-col gap-3 p-4">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : (
                  <RunSettingsForm
                    value={settings}
                    onChange={(next) => setOverride(next)}
                    agents={catalog?.agents ?? []}
                    faultsEnabled={faultsEnabled}
                    maxConcurrencyLimit={maxLimit}
                    onReset={() => setOverride(null)}
                    toolServers={toolServers}
                  />
                )}
              </PopoverContent>
            </Popover>
            <div className="ml-auto flex items-center gap-2.5">
              <span className="hidden items-center gap-1 sm:flex" aria-hidden="true">
                <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
                <Kbd>↵</Kbd>
              </span>
              <Button type="submit" variant="primary" disabled={!canRun} icon={<IconPlay size={14} weight="fill" aria-hidden="true" />}>
                {session.starting ? "Starting" : "Run"}
              </Button>
            </div>
          </div>
        </div>
      </form>

      {catalog?.mode === "offline" && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-fg-2">
          <IconOffline size={14} aria-hidden="true" />
          Offline demo: agents use stand-in models, so answers are simulated.
        </p>
      )}

      <section aria-labelledby={`${ids}-examples`} className="mt-12">
        <h2 id={`${ids}-examples`} className="text-sm font-medium text-fg-2">
          Try an example
        </h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {EXAMPLE_PROMPTS.map((example) => (
            <li key={example.title}>
              <button
                type="button"
                onClick={() => {
                  setQuery(example.query);
                  textareaRef.current?.focus();
                }}
                className="ax-press flex h-full w-full flex-col gap-1 rounded-lg border border-line bg-surface px-4 py-3 text-left hover:border-line-strong hover:bg-raised"
              >
                <span className="text-sm font-medium text-fg">{example.title}</span>
                <span className="line-clamp-2 text-sm text-fg-2">{example.query}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
