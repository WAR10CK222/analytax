import { buttonClass, IconButton, iconButtonClass } from "../components/ui/Button";
import { IconAgents, IconClose, IconLive, IconMoon, IconOffline, IconPlus, IconSidebar, IconSun, IconSystem } from "../components/ui/icons";
import { LogoMark } from "../components/ui/LogoMark";
import { Menu, MenuContent, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger, Tooltip } from "../components/ui/Overlay";
import { StatusIcon } from "../components/ui/Status";
import { RelativeTime } from "../components/ui/time";
import { cx } from "../lib/cx";
import { runHistoryStore, useRunHistory, type HistoryStatus, type RunHistoryEntry } from "../lib/run-history";
import { tone, type Tone } from "../lib/status";
import { useTheme, type ThemePreference } from "../lib/theme";
import { routeSearch } from "../lib/url-state";
import { RUN_STATUS_TONE } from "../view-models/run-status";
import { useCatalogContext } from "./catalog";
import type { ShellActions } from "./shell-context";

const MISSING_TONE: Tone = tone("No longer on the server", "neutral", "canceled");

const historyTone = (status: HistoryStatus): Tone => (status === "missing" ? MISSING_TONE : RUN_STATUS_TONE[status]);

function RunRow({ entry, active, onOpen }: { entry: RunHistoryEntry; active: boolean; onOpen: (threadId: string) => void }) {
  const statusTone = historyTone(entry.status);
  return (
    <li className="group relative">
      <a
        href={routeSearch("", { thread: entry.threadId }) || "?"}
        aria-current={active ? "page" : undefined}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          onOpen(entry.threadId);
        }}
        className={cx(
          "ax-press block rounded-md px-2.5 py-2 pr-8 text-left",
          active ? "bg-selected" : "hover:bg-hover",
        )}
      >
        <span className="line-clamp-2 text-sm leading-snug text-fg">{entry.query ?? "Untitled run"}</span>
        <span className="mt-1 flex items-center gap-1.5 text-xs text-fg-3">
          <StatusIcon tone={statusTone} size={12} />
          <span className="min-w-0 truncate">{statusTone.label}</span>
          <RelativeTime ts={entry.updatedAt} className="ml-auto shrink-0" />
        </span>
      </a>
      <button
        type="button"
        aria-label={`Remove "${entry.query ?? "Untitled run"}" from the list`}
        onClick={() => runHistoryStore.remove(entry.threadId)}
        className="absolute top-1.5 right-1.5 hidden size-6 items-center justify-center rounded-sm text-fg-3 group-hover:flex hover:bg-hover hover:text-fg focus-visible:flex"
      >
        <IconClose size={12} aria-hidden="true" />
      </button>
    </li>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof IconSun }[] = [
  { value: "system", label: "Match system", icon: IconSystem },
  { value: "light", label: "Light", icon: IconSun },
  { value: "dark", label: "Dark", icon: IconMoon },
];

function ThemeToggle() {
  const { preference, resolved, setPreference } = useTheme();
  const CurrentIcon = preference === "system" ? IconSystem : resolved === "dark" ? IconMoon : IconSun;
  return (
    <Menu>
      <Tooltip content="Theme">
        <MenuTrigger className={iconButtonClass("ghost", "md")} aria-label={`Theme: ${THEME_OPTIONS.find((o) => o.value === preference)?.label}`}>
          <CurrentIcon size={16} aria-hidden="true" />
        </MenuTrigger>
      </Tooltip>
      <MenuContent side="top" align="end">
        <MenuLabel>Theme</MenuLabel>
        <MenuRadioGroup value={preference} onValueChange={(next: ThemePreference) => setPreference(next)}>
          {THEME_OPTIONS.map((option) => (
            <MenuRadioItem key={option.value} value={option.value} icon={<option.icon size={16} aria-hidden="true" />}>
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

function ModeBadge() {
  const { catalog } = useCatalogContext();
  if (!catalog) return null;
  const offline = catalog.mode === "offline";
  const Icon = offline ? IconOffline : IconLive;
  return (
    <Tooltip content={offline ? "Answers come from built-in stand-in models. No Gemini calls are made." : "Agents call Gemini models with your API key."}>
      <span tabIndex={0} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-fg-2">
        <Icon size={14} aria-hidden="true" />
        {offline ? "Offline demo" : "Live models"}
      </span>
    </Tooltip>
  );
}

export function Sidebar({ currentThreadId, view, actions }: { currentThreadId: string | null; view: "agents" | null; actions: ShellActions }) {
  const history = useRunHistory();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 px-3">
        <button type="button" onClick={actions.newRun} className="flex items-center gap-2 rounded-md px-1 text-base font-semibold tracking-tight">
          <LogoMark size={24} />
          Analytax
        </button>
        <Tooltip content="Hide sidebar">
          <IconButton label="Hide sidebar" icon={<IconSidebar size={18} aria-hidden="true" />} onClick={actions.toggleSidebar} className="max-md:hidden" />
        </Tooltip>
      </div>

      <div className="px-3 pb-3">
        <button type="button" onClick={actions.newRun} className={cx(buttonClass("primary", "md"), "w-full")}>
          <IconPlus size={16} aria-hidden="true" />
          New run
        </button>
      </div>

      <nav aria-label="Runs" className="flex min-h-0 flex-1 flex-col">
        <h2 className="px-5 pt-2 pb-1.5 text-xs font-medium text-fg-3">Runs</h2>
        {history.length === 0 ? (
          <p className="px-5 text-sm text-fg-3">Runs you start or open appear here.</p>
        ) : (
          <ul className="scroll-thin flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
            {history.map((entry) => (
              <RunRow key={entry.threadId} entry={entry} active={view === null && entry.threadId === currentThreadId} onOpen={actions.openRun} />
            ))}
          </ul>
        )}
      </nav>

      <div className="flex shrink-0 flex-col gap-1 border-t border-line p-2">
        <button
          type="button"
          onClick={actions.openAgents}
          aria-current={view === "agents" ? "page" : undefined}
          className={cx("ax-press flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm", view === "agents" ? "bg-selected text-fg" : "text-fg-2 hover:bg-hover hover:text-fg")}
        >
          <IconAgents size={16} aria-hidden="true" />
          Agents
        </button>
        <div className="flex items-center justify-between gap-2">
          <ModeBadge />
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}
