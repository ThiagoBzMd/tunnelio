// @vitest-environment node
// Settings → Conversations rendered for real (React + a jsdom DOM) against the fake tray: a current
// tray shows counts and size and deletes everything; an older tray shows the update hint and no
// button; an offline computer asks to be turned on.
//
// The DOM is installed by hand (not the jsdom environment) so typed arrays, TextEncoder and
// WebCrypto stay Node's: the session handshake's AES keys come from Node's SubtleCrypto, which
// rejects buffers created in jsdom's realm.

import { JSDOM } from "jsdom";
import type * as React from "react";
import type * as ReactDomClient from "react-dom/client";
import type { ConversationsSection as ConversationsSectionT } from "../src/components/settings/ConversationsSection";
import type { TooltipProvider as TooltipProviderT } from "../src/components/ui/tooltip";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pairingIdFromPK } from "../src/crypto/pairing";
import { randomBytes } from "../src/crypto/bytes";
import { createApi } from "../src/lib/api";
import { createMemoryStorage } from "../src/lib/storage";
import { RelayClient } from "../src/relay/client";
import { chatStore, configureRuntime, devicesStore, historyStore, resetAllStores, settingsStore, wireStores } from "../src/stores";
import { DEVICE_ID, FakeRelay, type FakeDeviceOptions, type FakeHistoryState } from "./helpers/fake-device";
import { createFakeServer } from "./helpers/fake-server";
import { FakeTimers } from "./helpers/fake-timers";
import { FakeWebSocket } from "./helpers/fake-ws";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
// DOM events must be jsdom's (its nodes reject Node's own Event); everything else Node already has stays Node's.
const FROM_DOM = new Set(["Event", "CustomEvent", "EventTarget"]);
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis && !FROM_DOM.has(key)) continue;
  Object.defineProperty(globalThis, key, { configurable: true, get: () => (dom.window as unknown as Record<string, unknown>)[key] });
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// React and the component tree load after the DOM exists (type-only imports are erased).
let act: typeof React.act;
let createElement: typeof React.createElement;
let createRoot: typeof ReactDomClient.createRoot;
let ConversationsSection: typeof ConversationsSectionT;
let TooltipProvider: typeof TooltipProviderT;
beforeAll(async () => {
  ({ act, createElement } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ ConversationsSection } = await import("../src/components/settings/ConversationsSection"));
  ({ TooltipProvider } = await import("../src/components/ui/tooltip"));
});

type Root = ReturnType<typeof ReactDomClient.createRoot>;
let root: Root | null = null;
let host: HTMLDivElement;
let timers: FakeTimers;
let unwire: () => void;

async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await timers.flush(2);
    });
  }
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (cond()) return;
    await settle(1);
  }
  throw new Error(`timed out waiting for ${what}; DOM: ${host.textContent}; totals: ${JSON.stringify(historyStore.getState().totals)}`);
}

/** A paired computer on a fake relay; `online: false` keeps it offline. */
async function setup(opts: { online?: boolean; device?: FakeDeviceOptions } = {}) {
  FakeWebSocket.reset();
  resetAllStores();
  settingsStore.getState().reset();
  timers = new FakeTimers();
  const srv = createFakeServer();
  const api = createApi({ fetch: srv.fetch, getCsrfToken: () => srv.cookies.get("csrftoken") ?? null });
  const storage = createMemoryStorage();
  const relay = new RelayClient({ url: "ws://t/ws/client", appVersion: "t", WebSocket: FakeWebSocket, timers, random: () => 0, log: () => undefined });
  configureRuntime({ api, storage, relay, timers, appVersion: "t" });
  unwire = wireStores(relay);
  relay.connect();
  const fake = new FakeRelay({ deviceOnline: opts.online ?? true, ...(opts.device ? { device: opts.device } : {}) });
  fake.attach();
  await timers.flush();
  const pk = randomBytes(32);
  fake.device.addPairing(pk);
  await storage.pairings.put({ device_id: DEVICE_ID, pairing_id: pairingIdFromPK(pk), pk, name: "hal9000", created_at: "t" });
  devicesStore.setState({
    devices: { [DEVICE_ID]: { id: DEVICE_ID, name: "hal9000", platform: "linux", tray_version: "1.4.0", created_at: "t", last_seen_at: null, online: opts.online ?? true, paired: true } },
    order: [DEVICE_ID],
    loaded: true,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(TooltipProvider, null, createElement(ConversationsSection)));
  });
  return fake;
}

const row = () => host.querySelector<HTMLElement>('[data-testid="conversations-row"]');
const summary = () => host.querySelector('[data-testid="conversations-summary"]')?.textContent ?? "";

describe("Settings → Conversations", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    unwire?.();
  });

  it("current tray: '<name> · N conversations · size', Delete all asks, clears, refreshes", async () => {
    const history: FakeHistoryState = { conversations: 45, bytes: 120 * 1000 * 1000, cleared: false };
    const fake = await setup({ device: { history } });
    await waitFor(() => row()?.dataset.count === "45" && row()?.dataset.canClear === "true", "totals + capability");
    expect(summary()).toBe("hal9000 · 45 conversations · 120 MB");
    const conv = chatStore.getState().create({ device_id: DEVICE_ID, model: "m" });
    const button = host.querySelector<HTMLButtonElement>('[data-testid="conversations-delete-all"]')!;
    await act(async () => button.click());
    const dialogTitle = document.body.querySelector('[role="alertdialog"] h2')?.textContent;
    expect(dialogTitle).toBe("Delete all conversations on hal9000?");
    expect(document.body.textContent).toContain("This can't be undone.");
    const confirm = document.body.querySelector<HTMLButtonElement>('[data-testid="conversations-delete-confirm"]')!;
    await act(async () => confirm.click());
    await waitFor(() => summary() === "hal9000 · 0 conversations · 4.1 KB", "refreshed totals");
    expect(fake.device.received.some((r) => r.type === "history_clear")).toBe(true);
    expect(chatStore.getState().conversations[conv.id]).toBeUndefined();
    expect(historyStore.getState().privateByDevice[DEVICE_ID]?.items).toEqual([]);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="conversations-delete-all"]')?.disabled).toBe(true);
  });

  it("older tray: counts only if sent, no Delete all, a hint to update", async () => {
    await setup({ device: { history: null, deviceInfo: { capabilities: ["history", "think", "images"] } } });
    await waitFor(() => host.querySelector('[data-testid="conversations-old"]') !== null, "the update hint");
    expect(summary()).toBe("hal9000");
    expect(host.textContent).toContain("Update Tunnelio on this computer to delete everything at once.");
    expect(host.querySelector('[data-testid="conversations-delete-all"]')).toBeNull();
  });

  it("offline computer: asks to turn it on, nothing else", async () => {
    const fake = await setup({ online: false });
    await settle();
    expect(row()?.dataset.online).toBe("false");
    expect(summary()).toBe("hal9000");
    expect(host.textContent).toContain("Turn on hal9000 to see its conversations.");
    expect(host.querySelector('[data-testid="conversations-delete-all"]')).toBeNull();
    expect(fake.device.received).toEqual([]);
  });
});
