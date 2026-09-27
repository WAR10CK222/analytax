import { useCallback, useSyncExternalStore } from "react";
import { readStorage, writeStorage } from "./storage";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "analytax.theme";

const THEME_COLOR: Record<ResolvedTheme, string> = { light: "#f5f5f6", dark: "#0c0c0e" };

export function parsePreference(raw: string | null): ThemePreference {
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

const listeners = new Set<() => void>();
let preference: ThemePreference = typeof window === "undefined" ? "system" : parsePreference(readStorage(THEME_STORAGE_KEY));

const darkQuery = (): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function emit(): void {
  for (const listener of listeners) listener();
}

function applyToDocument(next: ThemePreference): void {
  const root = document.documentElement;
  // One frame without transitions so the whole page does not animate its colours.
  root.dataset.themeSwitching = "";
  if (next === "system") delete root.dataset.theme;
  else root.dataset.theme = next;
  const resolved = resolveTheme(next, darkQuery()?.matches ?? false);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    if (next === "system") meta.content = meta.media.includes("dark") ? THEME_COLOR.dark : THEME_COLOR.light;
    else meta.content = THEME_COLOR[resolved];
  }
  requestAnimationFrame(() => requestAnimationFrame(() => delete root.dataset.themeSwitching));
}

export function setThemePreference(next: ThemePreference): void {
  if (next === preference) return;
  preference = next;
  writeStorage(THEME_STORAGE_KEY, next === "system" ? null : next);
  applyToDocument(next);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const query = darkQuery();
  const onSystemChange = () => listener();
  query?.addEventListener("change", onSystemChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    preference = parsePreference(event.newValue);
    applyToDocument(preference);
    emit();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    query?.removeEventListener("change", onSystemChange);
    window.removeEventListener("storage", onStorage);
  };
}

const getPreference = (): ThemePreference => preference;
const getSystemDark = (): boolean => darkQuery()?.matches ?? false;

export function useTheme(): { preference: ThemePreference; resolved: ResolvedTheme; setPreference: (next: ThemePreference) => void } {
  const current = useSyncExternalStore(subscribe, getPreference, () => "system" as const);
  const systemDark = useSyncExternalStore(subscribe, getSystemDark, () => false);
  const setPreference = useCallback((next: ThemePreference) => setThemePreference(next), []);
  return { preference: current, resolved: resolveTheme(current, systemDark), setPreference };
}
