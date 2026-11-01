// Store wiring: relay events → stores, logout → resets, password change → disconnect, app bootstrap.

import type { RelayClient } from "../relay/client";
import { authStore, registerDisconnectHook, registerLogoutHook, registerPasswordHook } from "./auth";
import { chatStore } from "./chat";
import { devicesStore } from "./devices";
import { historyStore } from "./history";
import { libraryStore } from "./library";
import { modelsStore } from "./models";
import { pushPreferences, resetPreferencesSync, startPreferencesSync, syncPreferences } from "./preferences-sync";
import { getRuntime } from "./runtime";
import { sessionsStore } from "./sessions";
import { settingsStore } from "./settings";

export * from "./runtime";
export * from "./util";
export * from "./auth";
export * from "./devices";
export * from "./sessions";
export * from "./chat";
export * from "./models";
export * from "./history";
export * from "./library";
export * from "./settings";
export * from "./pairing-sync";
export * from "./preferences-sync";

/** Forget everything tied to the signed-in account (sessions, chats, caches). */
export function resetAllStores(): void {
  sessionsStore.getState().reset();
  chatStore.getState().reset();
  modelsStore.getState().reset();
  historyStore.getState().reset();
  libraryStore.getState().reset();
  devicesStore.getState().reset();
}

let wired = false;

/** Subscribe the stores to relay presence/auth events. Idempotent per relay instance. */
export function wireStores(relay: RelayClient = getRuntime().relay): () => void {
  const offs = [
    relay.on("welcome", (w) => devicesStore.getState().applyWelcome(w)),
    relay.on("device_status", (s) => devicesStore.getState().setPresence(s.device_id, s.online)),
    relay.on("auth_lost", () => {
      void authStore.getState().refresh();
    }),
  ];
  const unregister = wired
    ? () => undefined
    : (() => {
        const offLogout = registerLogoutHook(async () => {
          resetAllStores();
          await resetPreferencesSync();
        });
        const offPrefs = startPreferencesSync();
        const offPassword = registerPasswordHook(() => pushPreferences().catch(() => undefined));
        const offDisconnect = registerDisconnectHook(async () => {
          await devicesStore.getState().disconnectAll();
          chatStore.getState().reset();
          modelsStore.getState().reset();
          historyStore.getState().reset();
          libraryStore.getState().reset();
        });
        return () => {
          offLogout();
          offDisconnect();
          offPrefs();
          offPassword();
        };
      })();
  wired = true;
  return () => {
    for (const off of offs) off();
    unregister();
    wired = false;
  };
}

/** Signed-in account state: the device list (imports the synced pairings) and the synced preferences. */
export async function loadAccount(): Promise<void> {
  await devicesStore.getState().refresh();
  await syncPreferences().catch((e: unknown) => console.warn("[prefs] sync failed", e)); // the copy in this browser stays
}

/**
 * App start: CSRF + me; when signed in, connect the relay and load devices/settings.
 * Returns the auth status so the router can pick the first screen.
 */
export async function startApp(): Promise<"anonymous" | "authenticated" | "unknown"> {
  const { relay } = getRuntime();
  wireStores(relay);
  await settingsStore.getState().load();
  const status = await authStore.getState().bootstrap();
  if (status === "authenticated") {
    relay.connect();
    await loadAccount();
  }
  return status;
}
