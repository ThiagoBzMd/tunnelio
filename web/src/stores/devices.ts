// Devices: REST list (SPEC §11.2) merged with live presence from the relay (§3.3 welcome/device_status)
// and with the local pairing table (which device this browser can actually talk to). The REST list is
// authoritative: a pairing whose device is gone from the account (revoked, password changed/reset)
// is dropped locally. Pairings are synced between browsers (stores/pairing-sync.ts): `refresh`
// imports what other browsers paired, pairing / forget / remove push the change.

import { createStore } from "zustand/vanilla";
import type { DeviceRecord } from "../lib/api";
import type { WelcomeFrame } from "../protocol/relay";
import { syncPairings } from "./pairing-sync";
import { getRuntime } from "./runtime";
import { sessionsStore } from "./sessions";
import { errorMessage } from "./util";

export interface DeviceEntry extends DeviceRecord {
  /** A pairing (PK) for this device exists in local storage. */
  paired: boolean;
}

export interface DevicesState {
  devices: Record<string, DeviceEntry>;
  order: string[];
  loaded: boolean;
  busy: boolean;
  error: string | null;
  /** Last pairing-sync failure (the device list itself still loaded). */
  syncError: string | null;

  /** REST list + local pairings + synced pairings (imports pairings made on other browsers). */
  refresh(): Promise<DeviceEntry[]>;
  rename(id: string, name: string): Promise<boolean>;
  /** Revoke on the server, drop the local + synced pairing and close the session. */
  remove(id: string): Promise<boolean>;
  /** Drop the local pairing and remove it from the synced set (the device stays on the account). */
  forget(id: string): Promise<void>;
  /** Push local pairings to the server (sealed) / import new ones (after a pairing). */
  sync(): Promise<void>;
  /** Every device of the account is gone (password change/reset): forget all pairings and sessions. */
  disconnectAll(): Promise<void>;
  setPresence(id: string, online: boolean): void;
  applyWelcome(frame: WelcomeFrame): void;
  markPaired(id: string, name?: string): void;
  reset(): void;
}

const EMPTY: Pick<DevicesState, "devices" | "order" | "loaded" | "busy" | "error" | "syncError"> = {
  devices: {},
  order: [],
  loaded: false,
  busy: false,
  error: null,
  syncError: null,
};

function sortIds(devices: Record<string, DeviceEntry>): string[] {
  return Object.values(devices)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
    .map((d) => d.id);
}

export const devicesStore = createStore<DevicesState>((set, get) => {
  const applyPaired = (paired: ReadonlySet<string>) => {
    const devices = { ...get().devices };
    for (const id of Object.keys(devices)) devices[id] = { ...devices[id]!, paired: paired.has(id) };
    set({ devices, order: sortIds(devices) });
  };

  /** Run the sync and reflect the result; failures are recorded in `syncError`, never thrown. */
  const runSync = async (opts: Parameters<typeof syncPairings>[0]): Promise<void> => {
    const { storage } = getRuntime();
    try {
      await syncPairings(opts);
      set({ syncError: null });
    } catch (e) {
      set({ syncError: errorMessage(e) });
    }
    const paired = new Set((await storage.pairings.list().catch(() => [])).map((p) => p.device_id));
    applyPaired(paired);
  };

  return {
    ...EMPTY,

    refresh: async () => {
      const { api, storage } = getRuntime();
      set({ busy: true, error: null });
      try {
        const list = await api.listDevices();
        const known = new Set(list.map((d) => d.id));
        // Pairings of devices no longer on the account are useless (and the tray forgot them too).
        for (const p of await storage.pairings.list()) {
          if (known.has(p.device_id)) continue;
          sessionsStore.getState().close(p.device_id);
          await storage.pairings.delete(p.device_id).catch(() => undefined);
        }
        try {
          await syncPairings({ knownDevices: known });
          set({ syncError: null });
        } catch (e) {
          set({ syncError: errorMessage(e) });
        }
        const paired = new Set((await storage.pairings.list()).map((p) => p.device_id));
        const devices: Record<string, DeviceEntry> = {};
        for (const d of list) devices[d.id] = { ...d, paired: paired.has(d.id) };
        set({ devices, order: sortIds(devices), loaded: true, busy: false });
        return Object.values(devices);
      } catch (e) {
        set({ busy: false, error: errorMessage(e) });
        return Object.values(get().devices);
      }
    },

    rename: async (id, name) => {
      const { api } = getRuntime();
      try {
        await api.renameDevice(id, name);
        const cur = get().devices[id];
        if (cur) {
          const devices = { ...get().devices, [id]: { ...cur, name } };
          set({ devices, order: sortIds(devices) });
        }
        return true;
      } catch (e) {
        set({ error: errorMessage(e) });
        return false;
      }
    },

    remove: async (id) => {
      const { api, storage } = getRuntime();
      try {
        await api.deleteDevice(id);
      } catch (e) {
        set({ error: errorMessage(e) });
        return false;
      }
      sessionsStore.getState().close(id);
      await storage.pairings.delete(id).catch(() => undefined);
      const devices = { ...get().devices };
      delete devices[id];
      set({ devices, order: sortIds(devices) });
      await runSync({ exclude: [id] });
      return true;
    },

    forget: async (id) => {
      const { storage } = getRuntime();
      sessionsStore.getState().close(id);
      await storage.pairings.delete(id);
      const cur = get().devices[id];
      if (cur) set({ devices: { ...get().devices, [id]: { ...cur, paired: false } } });
      await runSync({ exclude: [id] });
    },

    sync: async () => {
      const known = get().loaded ? new Set(Object.keys(get().devices)) : null;
      await runSync({ knownDevices: known });
    },

    disconnectAll: async () => {
      const { storage } = getRuntime();
      sessionsStore.getState().closeAll();
      await storage.pairings.clear().catch(() => undefined);
      set({ devices: {}, order: [], loaded: true });
    },

    setPresence: (id, online) => {
      const cur = get().devices[id];
      if (!cur || cur.online === online) return;
      const devices = { ...get().devices, [id]: { ...cur, online } };
      set({ devices, order: sortIds(devices) });
    },

    applyWelcome: (frame) => {
      const devices = { ...get().devices };
      for (const d of frame.devices) {
        const cur = devices[d.device_id];
        devices[d.device_id] = cur
          ? { ...cur, name: d.name, online: d.online }
          : { id: d.device_id, name: d.name, platform: "", tray_version: "", created_at: "", last_seen_at: null, online: d.online, paired: false };
      }
      set({ devices, order: sortIds(devices) });
    },

    markPaired: (id, name) => {
      const cur = get().devices[id];
      const devices = {
        ...get().devices,
        [id]: cur
          ? { ...cur, paired: true, ...(name ? { name } : {}) }
          : { id, name: name ?? "", platform: "", tray_version: "", created_at: "", last_seen_at: null, online: true, paired: true },
      };
      set({ devices, order: sortIds(devices) });
    },

    reset: () => set({ ...EMPTY }),
  };
});
