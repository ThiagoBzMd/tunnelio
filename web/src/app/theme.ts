// Theme: `prefers-color-scheme` by default, manual override persisted in the settings store.
// Applies the `dark` class on <html> (Tailwind v4 `@custom-variant dark`) and the theme-color meta.

import { useSyncExternalStore } from "react";
import { useSettings } from "../stores/react";
import { settingsStore, type Settings } from "../stores/settings";

export type Theme = Settings["theme"];
export type ResolvedTheme = "light" | "dark";

const LIGHT_COLOR = "#ffffff";
const DARK_COLOR = "#0a0a0a";

function mediaQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
}

export function systemTheme(): ResolvedTheme {
  return mediaQuery()?.matches ? "dark" : "light";
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? systemTheme() : theme;
}

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const dark = resolveTheme(theme) === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? DARK_COLOR : LIGHT_COLOR);
  // Mirror for the pre-paint script in index.html (the settings store stays the source of truth).
  try {
    localStorage.setItem("tunnelio.theme", theme);
  } catch {
    /* private mode / blocked storage */
  }
}

/** Keep <html> in sync with the settings store and the OS preference. Returns a disposer. */
export function startThemeSync(): () => void {
  const apply = () => applyTheme(settingsStore.getState().settings.theme);
  apply();
  const unsub = settingsStore.subscribe(apply);
  const mq = mediaQuery();
  mq?.addEventListener("change", apply);
  return () => {
    unsub();
    mq?.removeEventListener("change", apply);
  };
}

function subscribeSystem(cb: () => void): () => void {
  const mq = mediaQuery();
  mq?.addEventListener("change", cb);
  return () => mq?.removeEventListener("change", cb);
}

export function useResolvedTheme(): ResolvedTheme {
  const theme = useSettings((s) => s.settings.theme);
  const system = useSyncExternalStore(subscribeSystem, systemTheme, () => "light" as ResolvedTheme);
  return theme === "system" ? system : theme;
}
