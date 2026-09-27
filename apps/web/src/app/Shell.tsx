import { useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "../components/ui/Button";
import { Sheet } from "../components/ui/Dialog";
import { IconMenu } from "../components/ui/icons";
import { LogoMark } from "../components/ui/LogoMark";
import { AgentsPage } from "../features/agents/AgentsPage";
import { HomePage } from "../features/home/HomePage";
import { RunWorkspace } from "../features/run/RunWorkspace";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { readStorage, writeStorage } from "../lib/storage";
import { navigate, parseRoute, resolveScreen, useRoute } from "../lib/url-state";
import { RunSessionProvider, useRunSession } from "./session";
import { ShellContext, type ShellActions } from "./shell-context";
import { Sidebar } from "./Sidebar";

const SIDEBAR_KEY = "analytax.sidebar";

function MainArea() {
  const route = useRoute();
  const session = useRunSession();
  const screen = resolveScreen(route, { threadId: session.threadId, starting: session.starting });
  if (screen === "agents") return <AgentsPage />;
  if (screen === "run") return <RunWorkspace />;
  return <HomePage />;
}

/**
 * App frame: sidebar + main. Owns which run is open. Opening another run remounts the session provider (new key),
 * so each run gets a fresh stream; Back/Forward re-seed it when the URL's run differs from the open one.
 */
export function Shell() {
  const route = useRoute();
  const [seed, setSeed] = useState(() => ({ key: 0, threadId: route.thread }));
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(route.thread);
  const sessionThread = useRef<string | null>(route.thread);

  const wide = useMediaQuery("(min-width: 768px)");
  const [sidebarOpen, setSidebarOpen] = useState(() => readStorage(SIDEBAR_KEY) !== "closed");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const reseed = useCallback((threadId: string | null) => {
    sessionThread.current = threadId;
    setCurrentThreadId(threadId);
    setSeed((current) => ({ key: current.key + 1, threadId }));
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const next = parseRoute(window.location.search).thread;
      if (next !== sessionThread.current) reseed(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [reseed]);

  const onThreadId = useCallback((threadId: string | null) => {
    if (!threadId) return;
    sessionThread.current = threadId;
    setCurrentThreadId(threadId);
    const urlThread = parseRoute(window.location.search).thread;
    // From Home a new run is a new page (push, so Back returns Home); otherwise keep the URL in sync quietly.
    if (urlThread !== threadId) navigate({ thread: threadId, task: null }, { replace: urlThread !== null });
  }, []);

  const actions = useRef<ShellActions>({
    openRun: () => undefined,
    newRun: () => undefined,
    openAgents: () => undefined,
    toggleSidebar: () => undefined,
  });
  actions.current = {
    openRun: (threadId) => {
      setMobileNavOpen(false);
      navigate({ view: null, thread: threadId, tab: "overview", task: null });
      if (threadId !== sessionThread.current) reseed(threadId);
    },
    newRun: () => {
      setMobileNavOpen(false);
      navigate({ view: null, thread: null, tab: "overview", task: null });
      reseed(null);
    },
    openAgents: () => {
      setMobileNavOpen(false);
      navigate({ view: "agents", task: null });
    },
    toggleSidebar: () => {
      if (!wide) {
        setMobileNavOpen((open) => !open);
        return;
      }
      setSidebarOpen((open) => {
        writeStorage(SIDEBAR_KEY, open ? "closed" : null);
        return !open;
      });
    },
  };
  const stableActions = useRef<ShellActions>({
    openRun: (id) => actions.current.openRun(id),
    newRun: () => actions.current.newRun(),
    openAgents: () => actions.current.openAgents(),
    toggleSidebar: () => actions.current.toggleSidebar(),
  }).current;

  const sidebar = <Sidebar currentThreadId={currentThreadId} view={route.view} actions={stableActions} />;

  return (
    <ShellContext.Provider value={{ actions: stableActions, sidebarOpen: wide ? sidebarOpen : false }}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[80] focus:rounded-md focus:bg-raised focus:px-3 focus:py-2 focus:shadow-overlay"
      >
        Skip to content
      </a>
      <div className="flex min-h-dvh bg-canvas text-fg">
        {wide && sidebarOpen && (
          <aside aria-label="Navigation" className="sticky top-0 flex h-dvh w-62 shrink-0 flex-col border-r border-line bg-surface">
            {sidebar}
          </aside>
        )}
        {!wide && (
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen} side="left" label="Navigation" className="w-[min(85vw,18rem)]">
            {sidebar}
          </Sheet>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {!wide && (
            <div className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-line bg-surface/90 px-2 backdrop-blur-md">
              <IconButton label="Open navigation" icon={<IconMenu size={20} aria-hidden="true" />} onClick={() => setMobileNavOpen(true)} />
              <button type="button" className="flex items-center gap-2 text-base font-semibold" onClick={() => stableActions.newRun()}>
                <LogoMark size={22} />
                Analytax
              </button>
            </div>
          )}
          <main id="main" className="flex min-w-0 flex-1 flex-col">
            <RunSessionProvider key={seed.key} initialThreadId={seed.threadId} onThreadId={onThreadId}>
              <MainArea />
            </RunSessionProvider>
          </main>
        </div>
      </div>
    </ShellContext.Provider>
  );
}
