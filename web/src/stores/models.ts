// Models per device: list / running / show / pull (streamed progress) / delete (SPEC §7.3, §8).
// Downloads (rev. 1.9): one at a time per computer (the tray's pull_concurrency), the next ones wait in
// this browser's queue; asking again for a model already downloading or queued joins it; a
// download goes on in the computer when the browser leaves, and a browser that comes back joins
// it from device_info.pull (SPEC §7.6).

import { createStore } from "zustand/vanilla";
import type { ModelInfoMessage, ModelSummary, RunningModel } from "../protocol/channel";
import { MODEL_NAME_RE, PULL_MODEL_NAME_RE } from "../protocol/constants";
import { newRequestId } from "../protocol/ids";
import { sessionsStore } from "./sessions";
import { errorMessage, nowIso } from "./util";

export interface PullState {
  name: string;
  status: string;
  total: number | null;
  completed: number | null;
  done: boolean;
  error: string | null;
  /** Waiting for another download of this browser to finish. */
  queued?: boolean;
  /** Canceled by the person (not an error). */
  canceled?: boolean;
  /** The pull_model request this browser waits on (abort cancels it). */
  request_id?: string;
}

export interface DeviceModels {
  models: ModelSummary[];
  running: RunningModel[];
  info: Record<string, ModelInfoMessage>;
  pulls: Record<string, PullState>;
  loading: boolean;
  loaded_at: string | null;
  error: string | null;
}

export interface ModelsState {
  byDevice: Record<string, DeviceModels>;
  list(deviceId: string): Promise<ModelSummary[]>;
  listRunning(deviceId: string): Promise<RunningModel[]>;
  show(deviceId: string, name: string): Promise<ModelInfoMessage | null>;
  /** Resolves true once downloaded (false: failed or canceled); never rejects. */
  pull(deviceId: string, name: string): Promise<boolean>;
  cancelPull(deviceId: string, name: string): Promise<void>;
  /** Forgets a finished, failed or canceled download. */
  dismissPull(deviceId: string, name: string): void;
  remove(deviceId: string, name: string): Promise<boolean>;
  reset(): void;
}

const EMPTY_DEVICE: DeviceModels = { models: [], running: [], info: {}, pulls: {}, loading: false, loaded_at: null, error: null };

/**
 * The context `model` is loaded with on that computer right now (SPEC §7.7), or null: not loaded,
 * an Ollama that does not say, or the computer could not be asked.
 */
export async function loadedContext(deviceId: string, model: string): Promise<number | null> {
  try {
    const running = await modelsStore.getState().listRunning(deviceId);
    const n = running.find((m) => m.name === model)?.context_length;
    return typeof n === "number" && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function isValidModelName(name: string): boolean {
  return MODEL_NAME_RE.test(name);
}

/**
 * Whether `model` on `deviceId` accepts images, from the cached `show_model` reply
 * (`model_info.capabilities` includes "vision"). `null` = not fetched yet (call `show()`).
 */
export function selectSupportsVision(state: ModelsState, deviceId: string, model: string): boolean | null {
  const info = state.byDevice[deviceId]?.info[model];
  if (!info) return null;
  return (info.capabilities ?? []).includes("vision");
}

export function supportsVision(deviceId: string, model: string): boolean | null {
  return selectSupportsVision(modelsStore.getState(), deviceId, model);
}
export function isValidPullName(name: string): boolean {
  return PULL_MODEL_NAME_RE.test(name);
}

// The downloads this browser waits on, and the end of each computer's queue.
const inFlight = new Map<string, Promise<boolean>>();
const queueTail = new Map<string, Promise<void>>();

export const modelsStore = createStore<ModelsState>((set, get) => {
  const entry = (deviceId: string): DeviceModels => get().byDevice[deviceId] ?? EMPTY_DEVICE;
  const patch = (deviceId: string, p: Partial<DeviceModels>) =>
    set({ byDevice: { ...get().byDevice, [deviceId]: { ...entry(deviceId), ...p } } });
  const patchPull = (deviceId: string, name: string, p: Partial<PullState>) => {
    const cur = entry(deviceId).pulls[name] ?? { name, status: "", total: null, completed: null, done: false, error: null };
    patch(deviceId, { pulls: { ...entry(deviceId).pulls, [name]: { ...cur, ...p } } });
  };

  return {
    byDevice: {},

    list: async (deviceId) => {
      patch(deviceId, { loading: true, error: null });
      try {
        const session = await sessionsStore.getState().open(deviceId);
        const res = await session.request({ type: "list_models", id: newRequestId() });
        patch(deviceId, { models: res.models, loading: false, loaded_at: nowIso() });
        return res.models;
      } catch (e) {
        patch(deviceId, { loading: false, error: errorMessage(e) });
        throw e;
      }
    },

    listRunning: async (deviceId) => {
      try {
        const session = await sessionsStore.getState().open(deviceId);
        const res = await session.request({ type: "list_running", id: newRequestId() });
        patch(deviceId, { running: res.models });
        return res.models;
      } catch (e) {
        patch(deviceId, { error: errorMessage(e) });
        throw e;
      }
    },

    show: async (deviceId, name) => {
      if (!isValidModelName(name)) {
        patch(deviceId, { error: "E_BAD_MODEL_NAME: invalid model name" });
        return null;
      }
      try {
        const session = await sessionsStore.getState().open(deviceId);
        const res = await session.request({ type: "show_model", id: newRequestId(), name });
        patch(deviceId, { info: { ...entry(deviceId).info, [name]: res } });
        return res;
      } catch (e) {
        patch(deviceId, { error: errorMessage(e) });
        return null;
      }
    },

    pull: (deviceId, name) => {
      if (!isValidPullName(name)) {
        patchPull(deviceId, name, { done: true, error: "E_BAD_MODEL_NAME: use family:tag or namespace/family:tag" });
        return Promise.resolve(false);
      }
      const key = `${deviceId}\n${name}`;
      const joined = inFlight.get(key);
      if (joined) return joined;
      const behind = queueTail.get(deviceId);
      patchPull(deviceId, name, { status: behind ? "queued" : "starting", queued: Boolean(behind), done: false, error: null, canceled: false, total: null, completed: null });
      const run = (async (): Promise<boolean> => {
        if (behind) await behind;
        if (entry(deviceId).pulls[name]?.canceled) return false; // canceled while it waited
        patchPull(deviceId, name, { status: "starting", queued: false });
        try {
          const session = await sessionsStore.getState().open(deviceId);
          const id = newRequestId();
          patchPull(deviceId, name, { request_id: id });
          await session.pull({ type: "pull_model", id, name }, (p) => {
            patchPull(deviceId, name, { status: p.status, total: p.total ?? null, completed: p.completed ?? null });
          });
          patchPull(deviceId, name, { status: "done", done: true });
          await get().list(deviceId).catch(() => undefined);
          return true;
        } catch (e) {
          const canceled = Boolean(entry(deviceId).pulls[name]?.canceled) || errorMessage(e).includes("pull canceled");
          patchPull(deviceId, name, canceled ? { done: true, canceled: true, error: null } : { done: true, error: errorMessage(e) });
          return false;
        }
      })();
      inFlight.set(key, run);
      const tail: Promise<void> = run.then(
        () => undefined,
        () => undefined,
      );
      queueTail.set(deviceId, tail);
      void tail.then(() => {
        inFlight.delete(key);
        if (queueTail.get(deviceId) === tail) queueTail.delete(deviceId);
      });
      return run;
    },

    cancelPull: async (deviceId, name) => {
      const p = entry(deviceId).pulls[name];
      if (!p || p.done) return;
      patchPull(deviceId, name, { canceled: true });
      if (p.queued) {
        patchPull(deviceId, name, { done: true, queued: false });
        return;
      }
      if (p.request_id) await sessionsStore.getState().get(deviceId)?.abort(p.request_id).catch(() => undefined);
    },

    dismissPull: (deviceId, name) => {
      const pulls = { ...entry(deviceId).pulls };
      delete pulls[name];
      patch(deviceId, { pulls });
    },

    remove: async (deviceId, name) => {
      if (!isValidModelName(name)) {
        patch(deviceId, { error: "E_BAD_MODEL_NAME: invalid model name" });
        return false;
      }
      try {
        const session = await sessionsStore.getState().open(deviceId);
        await session.request({ type: "delete_model", id: newRequestId(), name });
        patch(deviceId, { models: entry(deviceId).models.filter((m) => m.name !== name) });
        return true;
      } catch (e) {
        patch(deviceId, { error: errorMessage(e) });
        return false;
      }
    },

    reset: () => {
      inFlight.clear();
      queueTail.clear();
      set({ byDevice: {} });
    },
  };
});

// A download that goes on in the computer (started in another tab, or before this page opened)
// shows up again: asking for the same name joins it (SPEC §7.6).
sessionsStore.subscribe((state, prev) => {
  for (const [deviceId, session] of Object.entries(state.sessions)) {
    const name = session.device_info?.pull?.name;
    if (!name || prev.sessions[deviceId]?.device_info === session.device_info) continue;
    const cur = modelsStore.getState().byDevice[deviceId]?.pulls[name];
    if (!cur || cur.done) void modelsStore.getState().pull(deviceId, name);
  }
});
