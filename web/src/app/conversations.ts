// Conversation lookup for deep links (`/chat/:id`) when the conversation is not in memory yet:
// the history lives on the device that produced it.

import { chatStore } from "@/stores/chat";
import { devicesStore } from "@/stores/devices";
import { historyStore } from "@/stores/history";
import { settingsStore } from "@/stores/settings";

async function tryPrivate(deviceId: string, id: string): Promise<boolean> {
  try {
    await historyStore.getState().getPrivate(deviceId, id);
    return true;
  } catch {
    return false;
  }
}

/** Resolve once the app bootstrap has populated the devices (reload / deep link). */
function waitForBootstrap(timeoutMs = 15_000): Promise<void> {
  const ready = () => devicesStore.getState().loaded;
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      for (const u of unsubs) u();
      resolve();
    };
    const tick = () => {
      if (ready()) done();
    };
    const unsubs = [devicesStore.subscribe(tick)];
    const timer = setTimeout(done, timeoutMs);
  });
}

/** Load `id` into the chat store from wherever it lives. Resolves false when nothing was found. */
export async function resolveConversation(id: string): Promise<boolean> {
  if (chatStore.getState().conversations[id]) return true;
  await waitForBootstrap();
  const hist = historyStore.getState();
  const devs = devicesStore.getState();

  // 1. Known in an already loaded list.
  for (const [deviceId, h] of Object.entries(hist.privateByDevice)) {
    if (h.items.some((c) => c.id === id) && (await tryPrivate(deviceId, id))) return true;
  }

  // 2. Probe: preferred device first, then every paired online device.
  const preferred = settingsStore.getState().settings.default_device_id;
  const candidates = [preferred, ...devs.order].filter(
    (v, i, a): v is string => typeof v === "string" && a.indexOf(v) === i && devs.devices[v]?.paired === true && devs.devices[v]?.online === true,
  );
  for (const deviceId of candidates) {
    if (await tryPrivate(deviceId, id)) return true;
  }
  return false;
}
