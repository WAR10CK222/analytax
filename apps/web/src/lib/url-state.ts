import { useSyncExternalStore } from "react";

export type RunTab = "overview" | "plan" | "activity" | "usage";
export const RUN_TABS: readonly RunTab[] = ["overview", "plan", "activity", "usage"];

export type Route = {
  /** Non-run pages. `null` means Home or a run, depending on `thread`. */
  view: "agents" | null;
  thread: string | null;
  tab: RunTab;
  task: string | null;
};

const NAVIGATE_EVENT = "analytax:navigate";

const isTab = (value: string | null): value is RunTab => value !== null && (RUN_TABS as readonly string[]).includes(value);

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  const tab = params.get("tab");
  return {
    view: view === "agents" ? "agents" : null,
    thread: params.get("thread")?.trim() || null,
    tab: isTab(tab) ? tab : "overview",
    task: params.get("task")?.trim() || null,
  };
}

/** Applies a patch to the current query string. Unknown params survive; defaults are omitted to keep URLs short. */
export function routeSearch(current: string, patch: Partial<Route>): string {
  const params = new URLSearchParams(current);
  const set = (key: string, value: string | null | undefined) => {
    if (value) params.set(key, value);
    else params.delete(key);
  };
  if ("view" in patch) set("view", patch.view);
  if ("thread" in patch) set("thread", patch.thread);
  if ("tab" in patch) set("tab", patch.tab === "overview" ? null : patch.tab);
  if ("task" in patch) set("task", patch.task);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export type AppScreen = "home" | "run" | "agents";

export function resolveScreen(route: Route, session: { threadId: string | null; starting: boolean }): AppScreen {
  if (route.view === "agents") return "agents";
  if (route.thread || session.threadId || session.starting) return "run";
  return "home";
}

/** pushState for page changes (Back works); replace for tab, task and ids the stream assigns. */
export function navigate(patch: Partial<Route>, options: { replace?: boolean } = {}): void {
  const search = routeSearch(window.location.search, patch);
  const url = `${window.location.pathname}${search}${window.location.hash}`;
  if (url === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  if (options.replace) window.history.replaceState(window.history.state, "", url);
  else window.history.pushState(window.history.state, "", url);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

let cachedSearch: string | null = null;
let cachedRoute: Route = parseRoute("");

function getRoute(): Route {
  const search = window.location.search;
  if (search !== cachedSearch) {
    cachedSearch = search;
    cachedRoute = parseRoute(search);
  }
  return cachedRoute;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getRoute, () => cachedRoute);
}

/** A shareable link to a run. */
export function runLink(threadId: string): string {
  return `${window.location.origin}${window.location.pathname}${routeSearch("", { thread: threadId })}`;
}
