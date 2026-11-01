// Sessions: one DeviceSession per device_id, surfaced as serializable status for the UI.

import { createStore } from "zustand/vanilla";
import type { DeviceInfoMessage } from "../protocol/channel";
import { DeviceSession, SessionError, type SessionStatus } from "../session/device-session";
import { getRuntime } from "./runtime";

export interface SessionEntry {
  device_id: string;
  status: SessionStatus;
  device_info: DeviceInfoMessage | null;
  error: { code: string; message: string } | null;
}

export interface SessionsState {
  sessions: Record<string, SessionEntry>;

  /** Ensure a ready session (loads the pairing, runs the handshake). Throws `SessionError`. */
  open(deviceId: string): Promise<DeviceSession>;
  /** The live session object, if one was created. */
  get(deviceId: string): DeviceSession | null;
  /** Close and dispose; the next `open` builds a fresh session (used after re-pairing). */
  close(deviceId: string): void;
  closeAll(): void;
  reset(): void;
}

const live = new Map<string, DeviceSession>();
const inflight = new Map<string, Promise<DeviceSession>>();

export const sessionsStore = createStore<SessionsState>((set, get) => {
  const patch = (deviceId: string, p: Partial<SessionEntry>) => {
    const cur = get().sessions[deviceId] ?? { device_id: deviceId, status: "idle" as SessionStatus, device_info: null, error: null };
    set({ sessions: { ...get().sessions, [deviceId]: { ...cur, ...p } } });
  };

  return {
    sessions: {},

    open: async (deviceId) => {
      let s = live.get(deviceId);
      if (!s) {
        // Concurrent callers (e.g. two screens mounting at once) must share ONE DeviceSession:
        // two sessions would run two handshakes on the same relay session and one would fail.
        let creating = inflight.get(deviceId);
        if (!creating) {
          creating = (async () => {
            const { relay, storage, timers } = getRuntime();
            const rec = await storage.pairings.get(deviceId);
            if (!rec) {
              const err = new SessionError("E_UNKNOWN_PAIRING", "this browser is not paired with the device");
              patch(deviceId, { status: "needs-pairing", error: { code: err.code, message: err.message } });
              throw err;
            }
            const created = new DeviceSession(relay, { deviceId, pairing: rec, timers });
            created.on("status", (c) => {
              patch(deviceId, {
                status: c.status,
                error: c.error ? { code: c.error.code, message: c.error.message } : null,
                ...(c.status === "ready" ? {} : c.status === "closed" || c.status === "needs-pairing" ? { device_info: null } : {}),
              });
            });
            created.on("device_info", (info) => patch(deviceId, { device_info: info }));
            live.set(deviceId, created);
            patch(deviceId, { status: "idle", error: null });
            return created;
          })().finally(() => inflight.delete(deviceId));
          inflight.set(deviceId, creating);
        }
        s = await creating;
      }
      await s.open();
      return s;
    },

    get: (deviceId) => live.get(deviceId) ?? null,

    close: (deviceId) => {
      const s = live.get(deviceId);
      if (s) {
        s.dispose();
        live.delete(deviceId);
      }
      const sessions = { ...get().sessions };
      delete sessions[deviceId];
      set({ sessions });
    },

    closeAll: () => {
      for (const id of [...live.keys()]) get().close(id);
    },

    reset: () => {
      get().closeAll();
      set({ sessions: {} });
    },
  };
});
