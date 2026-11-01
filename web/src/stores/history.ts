// History: the private history kept by the tray (SQLite, read through the channel, SPEC §9).

import { createStore } from "zustand/vanilla";
import type { ConversationSummary, StoredMessage } from "../protocol/channel";
import { LIMITS } from "../protocol/constants";
import { newRequestId } from "../protocol/ids";
import type { ChatMessage, Conversation } from "./chat";
import { chatStore } from "./chat";
import { sessionsStore } from "./sessions";
import type { DeviceSession } from "../session/device-session";
import { errorMessage } from "./util";

export interface PrivateHistory {
  items: ConversationSummary[];
  has_more: boolean;
  loading: boolean;
  error: string | null;
}

/** rev. 1.4: what a device keeps (from `history_list`): `null` when an older tray does not say. */
export interface DeviceTotals {
  conversations: number | null;
  bytes: number | null;
  loading: boolean;
  /** `history_clear` in progress. */
  clearing: boolean;
  error: string | null;
}

export interface HistoryState {
  privateByDevice: Record<string, PrivateHistory>;
  totals: Record<string, DeviceTotals>;

  listPrivate(deviceId: string, opts?: { limit?: number; before?: string; append?: boolean }): Promise<ConversationSummary[]>;
  /** Fetch a private conversation and load it into the chat store. */
  getPrivate(deviceId: string, conversationId: string): Promise<Conversation>;
  deletePrivate(deviceId: string, conversationId: string): Promise<boolean>;
  /** `history_list {limit:1}` → totals of that device. */
  loadTotals(deviceId: string): Promise<DeviceTotals>;
  /** `history_clear`: every conversation on that device goes; open chats of it are closed. */
  clearAll(deviceId: string): Promise<boolean>;

  reset(): void;
}

/** `StoredMessage` (history_get) → in-memory message. */
export function storedToChatMessage(m: StoredMessage): ChatMessage {
  const msg: ChatMessage = { id: m.id, role: m.role, content: m.content, created_at: m.created_at };
  if (m.thinking !== undefined) msg.thinking = m.thinking;
  if (m.model !== undefined) msg.model = m.model;
  if (m.stats !== undefined) msg.stats = m.stats;
  if (m.aborted) msg.aborted = true;
  if (m.images && m.images.length > 0) msg.images = m.images;
  if (m.chain && m.chain.length > 0) msg.chain = m.chain;
  return msg;
}

/** Fetch one private conversation through an open session (all pages); does not touch the chat store. */
export async function fetchPrivate(session: DeviceSession, deviceId: string, conversationId: string): Promise<Conversation> {
  const messages: ChatMessage[] = [];
  let afterSeq = 0;
  let meta: Conversation | null = null;
  for (;;) {
    const res = await session.request({
      type: "history_get",
      id: newRequestId(),
      conversation_id: conversationId,
      after_seq: afterSeq,
      limit: LIMITS.HISTORY_GET_LIMIT_MAX,
    });
    meta ??= {
      id: res.conversation.id,
      title: res.conversation.title,
      model: res.conversation.model,
      device_id: deviceId,
      created_at: res.conversation.created_at,
      updated_at: res.conversation.updated_at,
      messages: [],
      ...(res.conversation.agent_id ? { agent_id: res.conversation.agent_id } : {}),
      ...(res.conversation.skill_ids && res.conversation.skill_ids.length > 0 ? { skill_ids: res.conversation.skill_ids } : {}),
    };
    for (const m of res.messages) {
      messages.push(storedToChatMessage(m));
      afterSeq = Math.max(afterSeq, m.seq);
    }
    if (!res.has_more || res.messages.length === 0) break;
  }
  return { ...(meta as Conversation), messages };
}

export const historyStore = createStore<HistoryState>((set, get) => {
  const patchPrivate = (deviceId: string, p: Partial<PrivateHistory>) => {
    const cur = get().privateByDevice[deviceId] ?? { items: [], has_more: false, loading: false, error: null };
    set({ privateByDevice: { ...get().privateByDevice, [deviceId]: { ...cur, ...p } } });
  };

  const EMPTY_TOTALS: DeviceTotals = { conversations: null, bytes: null, loading: false, clearing: false, error: null };
  const patchTotals = (deviceId: string, p: Partial<DeviceTotals>) => {
    const cur = get().totals[deviceId] ?? EMPTY_TOTALS;
    set({ totals: { ...get().totals, [deviceId]: { ...cur, ...p } } });
  };
  const fromResponse = (res: { total_conversations?: number; total_bytes?: number }): Partial<DeviceTotals> => ({
    conversations: typeof res.total_conversations === "number" ? res.total_conversations : null,
    bytes: typeof res.total_bytes === "number" ? res.total_bytes : null,
  });

  return {
    privateByDevice: {},
    totals: {},

    listPrivate: async (deviceId, opts = {}) => {
      patchPrivate(deviceId, { loading: true, error: null });
      try {
        const session = await sessionsStore.getState().open(deviceId);
        const res = await session.request({
          type: "history_list",
          id: newRequestId(),
          limit: Math.min(opts.limit ?? LIMITS.HISTORY_LIST_LIMIT_DEFAULT, LIMITS.HISTORY_LIST_LIMIT_MAX),
          ...(opts.before ? { before: opts.before } : {}),
        });
        const prev = opts.append ? (get().privateByDevice[deviceId]?.items ?? []) : [];
        const items = [...prev, ...res.conversations];
        patchPrivate(deviceId, { items, has_more: res.has_more, loading: false });
        if (res.total_conversations !== undefined || res.total_bytes !== undefined) patchTotals(deviceId, fromResponse(res));
        return items;
      } catch (e) {
        patchPrivate(deviceId, { loading: false, error: errorMessage(e) });
        throw e;
      }
    },

    getPrivate: async (deviceId, conversationId) => {
      const session = await sessionsStore.getState().open(deviceId);
      const conv = await fetchPrivate(session, deviceId, conversationId);
      chatStore.getState().upsert(conv);
      return conv;
    },

    deletePrivate: async (deviceId, conversationId) => {
      try {
        const session = await sessionsStore.getState().open(deviceId);
        await session.request({ type: "history_delete", id: newRequestId(), conversation_id: conversationId });
        const cur = get().privateByDevice[deviceId];
        if (cur) patchPrivate(deviceId, { items: cur.items.filter((c) => c.id !== conversationId) });
        chatStore.getState().remove(conversationId);
        return true;
      } catch (e) {
        patchPrivate(deviceId, { error: errorMessage(e) });
        return false;
      }
    },

    loadTotals: async (deviceId) => {
      patchTotals(deviceId, { loading: true, error: null });
      try {
        const session = await sessionsStore.getState().open(deviceId);
        const res = await session.request({ type: "history_list", id: newRequestId(), limit: 1 });
        patchTotals(deviceId, { ...fromResponse(res), loading: false });
      } catch (e) {
        patchTotals(deviceId, { loading: false, error: errorMessage(e) });
      }
      return get().totals[deviceId] ?? EMPTY_TOTALS;
    },

    clearAll: async (deviceId) => {
      patchTotals(deviceId, { clearing: true, error: null });
      try {
        const session = await sessionsStore.getState().open(deviceId);
        await session.request({ type: "history_clear", id: newRequestId() });
      } catch (e) {
        patchTotals(deviceId, { clearing: false, error: errorMessage(e) });
        return false;
      }
      // Nothing of that device is left: its list, and every conversation of it held in memory.
      patchPrivate(deviceId, { items: [], has_more: false, loading: false, error: null });
      const chat = chatStore.getState();
      for (const c of Object.values(chat.conversations)) if (c.device_id === deviceId) chat.remove(c.id);
      patchTotals(deviceId, { clearing: false, conversations: 0, bytes: null }); // the size comes back with the refresh
      await get().loadTotals(deviceId);
      return true;
    },

    reset: () => set({ privateByDevice: {}, totals: {} }),
  };
});
