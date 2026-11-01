// Runtime wiring for the stores: api client, storage, relay and timers are injected once so the
// same stores run in the browser (IndexedDB + WebSocket) and in Node (file storage + `ws`).

import { createApi, type Api } from "../lib/api";
import { createIndexedDbStorage, type AppStorage } from "../lib/storage";
import { realTimers, type Timers } from "../protocol/timers";
import { RelayClient } from "../relay/client";
import { relayUrl } from "../relay/url";

export interface Runtime {
  api: Api;
  storage: AppStorage;
  relay: RelayClient;
  timers: Timers;
  appVersion: string;
}

let current: Runtime | null = null;

export function configureRuntime(rt: Runtime): void {
  current = rt;
}

export function hasRuntime(): boolean {
  return current !== null;
}

export function getRuntime(): Runtime {
  if (!current) throw new Error("runtime not configured: call configureRuntime() first");
  return current;
}

export interface BrowserRuntimeOptions {
  appVersion?: string;
  /** Explicit origin; defaults to the page origin. */
  baseUrl?: string;
}

export function createBrowserRuntime(opts: BrowserRuntimeOptions = {}): Runtime {
  const appVersion = opts.appVersion ?? "0.0.0";
  const api = createApi(opts.baseUrl ? { baseUrl: opts.baseUrl } : {});
  const storage = createIndexedDbStorage();
  const relay = new RelayClient({ url: relayUrl(opts.baseUrl), appVersion });
  return { api, storage, relay, timers: realTimers, appVersion };
}
