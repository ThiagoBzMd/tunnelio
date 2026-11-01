// Whether the window is at least tablet/desktop wide (the `md` breakpoint), kept in sync.

import { useSyncExternalStore } from "react";

const QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

const snapshot = () => typeof window !== "undefined" && Boolean(window.matchMedia?.(QUERY).matches);

export function useWide(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}
