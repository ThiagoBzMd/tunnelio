// Chat: conversations in memory, streaming over DeviceSession; the tray keeps the history (SPEC §9).
// With an agent chain (rev. 1.9), the earlier agents answer first (chain.ts) and their answers go with
// the final request, kept with the reply.

import { createStore } from "zustand/vanilla";
import { randomUuid } from "../crypto/uuid";
import { chainSystem } from "../lib/agents";
import { planContext } from "../lib/context";
import { parseContent } from "../lib/documents/format";
import { checkImage } from "../lib/images";
import type { ChainStep, ChatDoneMessage, ChatMessageItem, ChatOptions, ChatRequest, ChatStats } from "../protocol/channel";
import type { ChatRole, KeepAlive } from "../protocol/constants";
import { LIMITS } from "../protocol/constants";
import { newRequestId } from "../protocol/ids";
import { ChainTooLongError, runChain, type ChainRun } from "./chain";
import { loadedContext, modelsStore } from "./models";
import { sessionsStore } from "./sessions";
import { errorCode, errorMessage, nowIso } from "./util";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  thinking?: string;
  created_at: string;
  model?: string;
  stats?: ChatStats;
  aborted?: boolean;
  /** User messages only: standard base64 of JPEG/PNG/WebP/GIF bytes (no data-URL prefix). */
  images?: string[];
  /** Streaming failed; the text is partial or empty. */
  error?: string;
  /** Still receiving chunks. */
  streaming?: boolean;
  /** rev. 1.9: a reply from an agent chain — what the agents before the last one answered. */
  chain?: ChainStep[];
  /** While a chain runs: how many agents answer in all (not kept). */
  chainTotal?: number;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  device_id: string;
  created_at: string;
  updated_at: string;
  messages: ChatMessage[];
  /** Anonymous chat: the computer keeps no history of it; it lives in this tab only (SPEC §7.3). */
  incognito?: boolean;
  /** rev. 1.8: the agent of this conversation, and the skills turned on in it (SPEC §9.4). */
  agent_id?: string;
  skill_ids?: string[];
}

export interface StreamingState {
  conversation_id: string;
  request_id: string;
  message_id: string;
  /** No chunk for the idle period (SPEC §7.6): the UI offers abort. */
  stalled: boolean;
}

export interface SendOptions {
  think?: boolean;
  options?: ChatOptions;
  keep_alive?: KeepAlive;
  /** Attached to the new user message (already prepared: base64, ≤ 4, ≤ 4 MiB each). */
  images?: string[];
  /** The agent's instructions and skills, sent first on every turn (never kept as a message). */
  system?: string;
  /** Recorded on the conversation by the computer (SPEC §9.4). */
  agent_id?: string;
  skill_ids?: string[];
  /** rev. 1.9: the agents that answer before this request's model, in order (SPEC §9.4). */
  chain?: ChainRun[];
}

export interface ChatState {
  conversations: Record<string, Conversation>;
  activeId: string | null;
  streaming: StreamingState | null;
  error: string | null;

  create(input: { device_id: string; model: string; title?: string; system?: string; incognito?: boolean }): Conversation;
  select(id: string | null): void;
  upsert(conv: Conversation): void;
  /**
   * Append a user message (text and/or images), stream the assistant reply. Resolves with
   * chat_done or null on failure; rejects before appending anything on empty input or
   * over-limit images (count, size, encoding).
   */
  send(conversationId: string, content: string, opts?: SendOptions): Promise<ChatDoneMessage | null>;
  abort(): Promise<void>;
  rename(conversationId: string, title: string): Promise<void>;
  remove(conversationId: string): void;
  clearError(): void;
  reset(): void;
}

/**
 * Default title: first 60 characters of the first user message (SPEC §9.2) — of the typed prompt
 * when documents lead the message, else the first document's name.
 */
export function defaultTitle(content: string): string {
  const { documents, prompt } = parseContent(content);
  const source = documents.length > 0 ? prompt.trim() || documents[0]!.name : content;
  const t = source.trim().replace(/\s+/g, " ").slice(0, 60);
  return t.length > 0 ? t : "New conversation";
}

export type ChatSendErrorCode = "E_EMPTY" | "E_IMAGES" | "E_TOO_LONG" | "E_TOO_LARGE";

/** Refused before anything is appended: the input stays with the user. */
export class ChatSendError extends Error {
  constructor(
    public readonly code: ChatSendErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChatSendError";
  }
}

/** `context_length` from show_model (cached per device and model), when known. */
export function contextLengthOf(deviceId: string, model: string): number | null {
  const n = modelsStore.getState().byDevice[deviceId]?.info[model]?.context_length;
  return typeof n === "number" && n > 0 ? n : null;
}

function messageBudget(deviceId: string): number {
  const device = sessionsStore.getState().sessions[deviceId]?.device_info?.limits.max_message_bytes;
  return Math.min(LIMITS.MAX_MESSAGE_BYTES, device ?? LIMITS.MAX_MESSAGE_BYTES);
}

/**
 * Everything checked before a user turn is appended (SPEC §0.3, §7.7): non-empty input, images
 * (count, encoding, size), the model memory rule (→ `num_ctx`, or too long for the model) and the
 * 8 MiB request cap (older turns lose their images first). Throws `ChatSendError`.
 */
export function validateSend(history: ChatMessage[], deviceId: string, model: string, content: string, images: string[] = [], system = ""): { num_ctx?: number } {
  const text = content.trim();
  if (!text && images.length === 0) throw new ChatSendError("E_EMPTY", "empty message");
  if (images.length > LIMITS.MAX_IMAGES_PER_MESSAGE) throw new ChatSendError("E_IMAGES", `at most ${LIMITS.MAX_IMAGES_PER_MESSAGE} images per message`);
  for (const img of images) {
    const problem = checkImage(img);
    if (problem === "E_TOO_LARGE") throw new ChatSendError("E_IMAGES", "image exceeds 4 MiB");
    if (problem) throw new ChatSendError("E_IMAGES", "image is not valid base64");
  }
  const draft: ChatMessage = { id: "draft", role: "user", content: text, created_at: "", ...(images.length > 0 ? { images } : {}) };
  const wire = withSystem(system, toWire([...history, draft]));
  const plan = planContext(
    wire.reduce((n, m) => n + m.content.length, 0),
    contextLengthOf(deviceId, model),
  );
  if (!plan.ok) throw new ChatSendError("E_TOO_LONG", "the conversation is too long for this model");
  const probe: ChatRequest = { type: "chat", id: "r".repeat(LIMITS.REQUEST_ID_MAX_LENGTH), conversation_id: randomUuid(), mode: "private", model, messages: wire, think: true };
  if (plan.num_ctx) probe.options = { num_ctx: plan.num_ctx };
  const budget = messageBudget(deviceId);
  fitImagesToBudget(probe, budget);
  if (utf8Bytes(JSON.stringify(probe)) > budget) throw new ChatSendError("E_TOO_LARGE", "the message exceeds 8 MiB");
  return plan.num_ctx ? { num_ctx: plan.num_ctx } : {};
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Ollama is stateless: every turn re-sends the whole thread, images of earlier user turns included. */
export function toWire(messages: ChatMessage[]): ChatMessageItem[] {
  const wire = messages
    .filter((m) => !m.streaming && !m.error)
    .map((m) => {
      const it: ChatMessageItem = { role: m.role, content: m.content };
      if (m.role === "user" && m.images && m.images.length > 0) it.images = m.images;
      return it;
    });
  if (wire.length > LIMITS.CHAT_MESSAGES_MAX) wire.splice(0, wire.length - LIMITS.CHAT_MESSAGES_MAX);
  return wire;
}

/** The agent's system message goes first; the oldest turns make room for it within the 500-item cap. */
export function withSystem(system: string, wire: ChatMessageItem[]): ChatMessageItem[] {
  if (!system.trim()) return wire;
  const rest = wire.length >= LIMITS.CHAT_MESSAGES_MAX ? wire.slice(wire.length - LIMITS.CHAT_MESSAGES_MAX + 1) : wire;
  return [{ role: "system", content: system }, ...rest];
}

/**
 * Keep the request under the device's plaintext cap by dropping images from the OLDEST user turns
 * first (the newest message keeps its images). Returns how many images were dropped.
 */
export function fitImagesToBudget(req: ChatRequest, budget: number): number {
  let dropped = 0;
  if (!req.messages.some((m) => m.images)) return 0;
  while (utf8Bytes(JSON.stringify(req)) > budget) {
    const victim = req.messages.slice(0, -1).find((m) => m.images && m.images.length > 0);
    if (!victim?.images) break;
    dropped += victim.images.length;
    delete victim.images;
  }
  return dropped;
}

export const chatStore = createStore<ChatState>((set, get) => {
  const patchConv = (id: string, fn: (c: Conversation) => Conversation) => {
    const cur = get().conversations[id];
    if (!cur) return;
    set({ conversations: { ...get().conversations, [id]: fn(cur) } });
  };
  const patchMessage = (convId: string, msgId: string, fn: (m: ChatMessage) => ChatMessage) => {
    patchConv(convId, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === msgId ? fn(m) : m)) }));
  };

  return {
    conversations: {},
    activeId: null,
    streaming: null,
    error: null,

    create: ({ device_id, model, title, system, incognito }) => {
      const now = nowIso();
      const messages: ChatMessage[] = [];
      if (system) messages.push({ id: randomUuid(), role: "system", content: system, created_at: now });
      const conv: Conversation = { id: randomUuid(), title: title ?? "", model, device_id, created_at: now, updated_at: now, messages, ...(incognito ? { incognito: true } : {}) };
      set({ conversations: { ...get().conversations, [conv.id]: conv }, activeId: conv.id });
      return conv;
    },

    select: (id) => set({ activeId: id }),

    upsert: (conv) => set({ conversations: { ...get().conversations, [conv.id]: conv } }),

    send: async (conversationId, content, opts = {}) => {
      const conv = get().conversations[conversationId];
      if (!conv) throw new Error("unknown conversation");
      if (get().streaming) throw new Error("a chat is already streaming");
      const text = content.trim();
      const images = opts.images ?? [];
      let system = opts.system ?? "";
      const plan = validateSend(conv.messages, conv.device_id, conv.model, text, images, system);

      const now = nowIso();
      const userMsg: ChatMessage = { id: randomUuid(), role: "user", content: text, created_at: now };
      if (images.length > 0) userMsg.images = images;
      const assistantMsg: ChatMessage = { id: randomUuid(), role: "assistant", content: "", created_at: now, model: conv.model, streaming: true };
      const isFirstUser = !conv.messages.some((m) => m.role === "user");
      const title = conv.title || defaultTitle(text);
      const setup: Pick<Conversation, "agent_id" | "skill_ids"> = {};
      if (opts.agent_id) setup.agent_id = opts.agent_id;
      if (opts.skill_ids && opts.skill_ids.length > 0) setup.skill_ids = opts.skill_ids;
      patchConv(conversationId, (c) => {
        const next: Conversation = { ...c, ...setup, title, updated_at: now, messages: [...c.messages, userMsg, assistantMsg] };
        if (!setup.agent_id) delete next.agent_id;
        if (!setup.skill_ids) delete next.skill_ids;
        return next;
      });

      const runs = opts.chain ?? [];
      const total = runs.length + 1;
      if (runs.length > 0) patchMessage(conversationId, assistantMsg.id, (m) => ({ ...m, chain: [], chainTotal: total }));

      // `mode` is a channel field (SPEC §7.3): "private" is kept by the device, "incognito" is not.
      const buildRequest = (finalSystem: string, numCtx: number | undefined): ChatRequest => {
        const wire = withSystem(finalSystem, toWire(get().conversations[conversationId]?.messages ?? []));
        const req: ChatRequest = { type: "chat", id: newRequestId(), conversation_id: conversationId, mode: conv.incognito ? "incognito" : "private", model: conv.model, messages: wire };
        if (opts.think !== undefined) req.think = opts.think;
        // Model memory (SPEC §7.7): recomputed on every send of the conversation.
        const options: ChatOptions = { ...(opts.options ?? {}), ...(numCtx ? { num_ctx: numCtx } : {}) };
        if (Object.keys(options).length > 0) req.options = options;
        if (opts.keep_alive) req.keep_alive = opts.keep_alive;
        if (setup.agent_id) req.agent_id = setup.agent_id;
        if (setup.skill_ids) req.skill_ids = setup.skill_ids;
        if (isFirstUser && utf8Bytes(title) <= LIMITS.CHAT_TITLE_MAX_BYTES) req.title = title;
        return req;
      };
      let req = buildRequest(system, plan.num_ctx);

      set({ streaming: { conversation_id: conversationId, request_id: req.id, message_id: assistantMsg.id, stalled: false }, error: null });
      const fail = (message: string) => {
        patchMessage(conversationId, assistantMsg.id, (m) => ({ ...m, streaming: false, error: message }));
        set({ error: message });
      };
      const markActive = (requestId?: string) => {
        const s = get().streaming;
        if (s && (s.stalled || (requestId && s.request_id !== requestId))) set({ streaming: { ...s, stalled: false, ...(requestId ? { request_id: requestId } : {}) } });
      };
      const onStalled = () => {
        const s = get().streaming;
        if (s) set({ streaming: { ...s, stalled: true } });
      };

      let done: ChatDoneMessage | null = null;
      try {
        const session = await sessionsStore.getState().open(conv.device_id);
        const budget = Math.min(LIMITS.MAX_MESSAGE_BYTES, session.deviceInfo?.limits.max_message_bytes ?? LIMITS.MAX_MESSAGE_BYTES);

        if (runs.length > 0) {
          const history = get().conversations[conversationId]?.messages ?? [];
          const outcome = await runChain(session, conv.device_id, conversationId, history, runs, total, budget, {
            onRequest: (id) => markActive(id),
            onStep: (index, step) =>
              patchMessage(conversationId, assistantMsg.id, (m) => {
                const chain = [...(m.chain ?? [])];
                chain[index] = step;
                return { ...m, chain };
              }),
            onStalled,
          });
          if (outcome.reason !== "stop") {
            // Stopped (or failed) before the last agent: nothing reaches the computer's history.
            patchMessage(conversationId, assistantMsg.id, (m) => {
              const out: ChatMessage = { ...m, chain: outcome.steps };
              delete out.streaming;
              delete out.chainTotal;
              if (outcome.reason === "abort") out.aborted = true;
              else out.error = "the device reported an error while generating";
              return out;
            });
            return null;
          }
          // The final agent builds on the last answer.
          const last = outcome.steps[outcome.steps.length - 1] as ChainStep;
          system = chainSystem(system, total, total, last);
          req.chain = outcome.steps;
        }
        // Model memory (SPEC §7.7): planned with the context Ollama has the model loaded with now.
        const finalPlan = planContext(
          withSystem(system, toWire(get().conversations[conversationId]?.messages ?? [])).reduce((n, m) => n + m.content.length, 0),
          contextLengthOf(conv.device_id, conv.model),
          await loadedContext(conv.device_id, conv.model),
        );
        if (!finalPlan.ok) throw new ChainTooLongError(conv.model);
        const chainSteps = req.chain;
        req = buildRequest(system, finalPlan.num_ctx);
        if (chainSteps) req.chain = chainSteps;
        markActive(req.id);

        fitImagesToBudget(req, budget);
        done = await session.stream(req, {
          onChunk: (chunk) => {
            markActive();
            patchMessage(conversationId, assistantMsg.id, (m) => ({
              ...m,
              content: m.content + chunk.content,
              ...(chunk.thinking ? { thinking: (m.thinking ?? "") + chunk.thinking } : {}),
            }));
          },
          onStalled,
        });
        const finishedAt = nowIso();
        patchMessage(conversationId, assistantMsg.id, (m) => {
          const out: ChatMessage = { ...m, streaming: false };
          delete out.streaming;
          delete out.chainTotal;
          if (done?.stats) out.stats = done.stats;
          if (done?.done_reason === "abort") out.aborted = true;
          if (done?.done_reason === "error") out.error = "the device reported an error while generating";
          if (done?.message_id) out.id = done.message_id;
          return out;
        });
        patchConv(conversationId, (c) => ({ ...c, updated_at: finishedAt }));
      } catch (e) {
        fail(e instanceof ChainTooLongError ? e.message : errorMessage(e));
      } finally {
        set({ streaming: null });
      }

      return done;
    },

    abort: async () => {
      const s = get().streaming;
      if (!s) return;
      const conv = get().conversations[s.conversation_id];
      if (!conv) return;
      const session = sessionsStore.getState().get(conv.device_id);
      if (!session) return;
      try {
        await session.abort(s.request_id);
      } catch (e) {
        // E_NOT_FOUND: the chat already finished (or belongs to another session) — nothing to abort.
        if (errorCode(e) !== "E_NOT_FOUND") set({ error: errorMessage(e) });
      }
    },

    rename: async (conversationId, title) => {
      // In memory only: the tray has no history_rename (SPEC §15).
      if (get().conversations[conversationId]) patchConv(conversationId, (c) => ({ ...c, title, updated_at: nowIso() }));
    },

    remove: (conversationId) => {
      const conversations = { ...get().conversations };
      delete conversations[conversationId];
      set({ conversations, activeId: get().activeId === conversationId ? null : get().activeId });
    },

    clearError: () => set({ error: null }),

    reset: () => set({ conversations: {}, activeId: null, streaming: null, error: null }),
  };
});
