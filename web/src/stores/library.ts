// Agents and skills of each computer (rev. 1.8, SPEC §9.4): kept by the tray next to the
// conversations, read and written through the encrypted channel (agent_list / agent_save /
// agent_delete, skill_list / skill_save / skill_delete). A computer whose app is older than
// the "agents" capability has none: `supported` is false and the screens ask to update it.

import { createStore } from "zustand/vanilla";
import type { Agent, AgentInput, Skill, SkillInput } from "../protocol/channel";
import { newRequestId } from "../protocol/ids";
import { sessionsStore } from "./sessions";
import { errorMessage } from "./util";

export interface DeviceLibrary {
  agents: Agent[];
  skills: Skill[];
  /** `null` until the computer said whether it keeps agents (its app version). */
  supported: boolean | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

export interface LibraryState {
  byDevice: Record<string, DeviceLibrary>;
  /** Both lists of the computer (again when `force`, else once). */
  load(deviceId: string, opts?: { force?: boolean }): Promise<DeviceLibrary>;
  /** Create or replace (same id). Rejects with the computer's error. */
  saveAgent(deviceId: string, agent: AgentInput): Promise<Agent>;
  deleteAgent(deviceId: string, agentId: string): Promise<void>;
  saveSkill(deviceId: string, skill: SkillInput): Promise<Skill>;
  /** The computer also takes the skill out of every agent that had selected it. */
  deleteSkill(deviceId: string, skillId: string): Promise<void>;
  reset(): void;
}

export const EMPTY_LIBRARY: DeviceLibrary = { agents: [], skills: [], supported: null, loaded: false, loading: false, error: null };

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);

const upsert = <T extends { id: string; name: string }>(list: T[], item: T): T[] => [...list.filter((x) => x.id !== item.id), item].sort(byName);

export const libraryStore = createStore<LibraryState>((set, get) => {
  const patch = (deviceId: string, p: Partial<DeviceLibrary>) => {
    const cur = get().byDevice[deviceId] ?? EMPTY_LIBRARY;
    set({ byDevice: { ...get().byDevice, [deviceId]: { ...cur, ...p } } });
  };
  const inflight = new Map<string, Promise<DeviceLibrary>>();

  const session = async (deviceId: string) => {
    const s = await sessionsStore.getState().open(deviceId);
    const supported = Boolean(s.deviceInfo?.capabilities.includes("agents"));
    if (!supported) patch(deviceId, { supported: false });
    return { s, supported };
  };

  return {
    byDevice: {},

    load: (deviceId, opts = {}) => {
      const cur = get().byDevice[deviceId];
      if (cur?.loaded && !opts.force) return Promise.resolve(cur);
      const running = inflight.get(deviceId);
      if (running) return running;
      const run = (async () => {
        patch(deviceId, { loading: true, error: null });
        try {
          const { s, supported } = await session(deviceId);
          if (!supported) {
            patch(deviceId, { agents: [], skills: [], loaded: true, loading: false });
          } else {
            const agents = await s.request({ type: "agent_list", id: newRequestId() });
            const skills = await s.request({ type: "skill_list", id: newRequestId() });
            patch(deviceId, { agents: [...agents.agents].sort(byName), skills: [...skills.skills].sort(byName), supported: true, loaded: true, loading: false });
          }
        } catch (e) {
          patch(deviceId, { loading: false, error: errorMessage(e) });
        } finally {
          inflight.delete(deviceId);
        }
        return get().byDevice[deviceId] ?? EMPTY_LIBRARY;
      })();
      inflight.set(deviceId, run);
      return run;
    },

    saveAgent: async (deviceId, agent) => {
      const { s } = await session(deviceId);
      const res = await s.request({ type: "agent_save", id: newRequestId(), agent });
      patch(deviceId, { agents: upsert(get().byDevice[deviceId]?.agents ?? [], res.agent) });
      return res.agent;
    },

    deleteAgent: async (deviceId, agentId) => {
      const { s } = await session(deviceId);
      await s.request({ type: "agent_delete", id: newRequestId(), agent_id: agentId });
      patch(deviceId, { agents: (get().byDevice[deviceId]?.agents ?? []).filter((a) => a.id !== agentId) });
    },

    saveSkill: async (deviceId, skill) => {
      const { s } = await session(deviceId);
      const res = await s.request({ type: "skill_save", id: newRequestId(), skill });
      patch(deviceId, { skills: upsert(get().byDevice[deviceId]?.skills ?? [], res.skill) });
      return res.skill;
    },

    deleteSkill: async (deviceId, skillId) => {
      const { s } = await session(deviceId);
      await s.request({ type: "skill_delete", id: newRequestId(), skill_id: skillId });
      const cur = get().byDevice[deviceId];
      patch(deviceId, {
        skills: (cur?.skills ?? []).filter((k) => k.id !== skillId),
        agents: (cur?.agents ?? []).map((a) => (a.skill_ids.includes(skillId) ? { ...a, skill_ids: a.skill_ids.filter((id) => id !== skillId) } : a)),
      });
    },

    reset: () => set({ byDevice: {} }),
  };
});
