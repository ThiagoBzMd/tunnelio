// Browser bootstrap: configure the runtime once and start the stores (CSRF, me, relay,
// devices + synced pairings).

import { createBrowserRuntime, configureRuntime, getRuntime, hasRuntime } from "../stores/runtime";
import { loadAccount, startApp } from "../stores/index";
import type { AuthStatus } from "../stores/auth";

export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
/** The release shown in Settings (web/package.json, set with each server/vX.Y.Z tag); null before the first. */
export const RELEASE_VERSION: string | null = /^\d+\.\d+\.\d+/.test(APP_VERSION) && APP_VERSION !== "0.0.0" ? APP_VERSION : null;

export function ensureRuntime(): void {
  if (!hasRuntime()) configureRuntime(createBrowserRuntime({ appVersion: APP_VERSION }));
}

let booted: Promise<AuthStatus> | null = null;

/** Idempotent app start (React StrictMode mounts effects twice in dev). */
export function boot(): Promise<AuthStatus> {
  ensureRuntime();
  booted ??= startApp();
  return booted;
}

/** After a successful login/register: connect the relay and load account state (devices + synced pairings). */
export async function afterLogin(): Promise<void> {
  const { relay } = getRuntime();
  relay.connect();
  await loadAccount();
}
