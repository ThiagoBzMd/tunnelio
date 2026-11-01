// User preferences. Persisted in the browser (IndexedDB `settings` store) as the working copy;
// the account-wide subset (SYNCED_KEYS) also travels sealed in the account (stores/preferences-sync.ts,
// SPEC §10.5) so every browser of the account gets it. The rest belongs to this browser.

import { createStore } from "zustand/vanilla";
import { hasCustomOptions, sanitizeModelOptions, type ModelOptions } from "../lib/model-options";
import type { KeepAlive } from "../protocol/constants";
import { getRuntime } from "./runtime";

export type Language = "en" | "pt-BR";

export interface Settings {
  theme: "system" | "light" | "dark";
  /** `null` = follow the browser language. */
  language: Language | null;
  default_device_id: string | null;
  default_model: string | null;
  think: boolean;
  keep_alive: KeepAlive | null;
  /** Show the dictation (speech-to-text) button in the composer. */
  dictation: boolean;
  /** The one-time "audio may be processed by your browser vendor" hint was shown. */
  dictation_hint_seen: boolean;
  /** Generation settings per model name (SPEC §8.3); absent = the model's own defaults. */
  model_options: Record<string, ModelOptions>;
  /** Desktop: the sidebar stays docked (true) or only shows while its button is hovered. */
  sidebar_pinned: boolean;
  /** Conversation ids pinned to the top of the sidebar, most recent pin first. */
  pinned_conversations: string[];
  /** "What should Tunnelio call you?" — `null` = the part of the e-mail before "@". */
  display_name: string | null;
}

/** The preferences of the person (synced, sealed, across browsers); the others belong to this browser. */
export const SYNCED_KEYS = ["theme", "language", "dictation", "think", "default_model", "model_options", "pinned_conversations", "display_name"] as const;
export type SyncedKey = (typeof SYNCED_KEYS)[number];
export type SyncedSettings = Pick<Settings, SyncedKey>;

export const DISPLAY_NAME_MAX = 40;

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  language: null,
  default_device_id: null,
  default_model: null,
  think: false,
  keep_alive: null,
  dictation: true,
  dictation_hint_seen: false,
  model_options: {},
  sidebar_pinned: true,
  pinned_conversations: [],
  display_name: null,
};

export function pickSynced(s: Settings): SyncedSettings {
  const out = {} as Record<SyncedKey, unknown>;
  for (const k of SYNCED_KEYS) out[k] = s[k];
  return out as SyncedSettings;
}

export interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load(): Promise<Settings>;
  update(patch: Partial<Settings>): Promise<Settings>;
  /** `null` or an empty object forgets the model's settings (back to its defaults). */
  setModelOptions(model: string, options: ModelOptions | null): Promise<Settings>;
  /** Pin (to the top) or unpin a conversation. */
  setPinned(conversationId: string, pinned: boolean): Promise<Settings>;
  /** Signed out: the person's preferences go back to the defaults in this browser. */
  resetSynced(): Promise<Settings>;
  reset(): void;
}

const KEY = "settings";

/** Keeps only known keys with valid values (stored data, synced documents). */
export function sanitizeSettings(v: unknown): Partial<Settings> {
  return sanitize(v);
}

function sanitize(v: unknown): Partial<Settings> {
  if (typeof v !== "object" || v === null) return {};
  const o = v as Record<string, unknown>;
  const out: Partial<Settings> = {};
  if (o.theme === "system" || o.theme === "light" || o.theme === "dark") out.theme = o.theme;
  if (o.language === "en" || o.language === "pt-BR" || o.language === null) out.language = o.language;
  if (typeof o.default_device_id === "string" || o.default_device_id === null) out.default_device_id = o.default_device_id;
  if (typeof o.default_model === "string" || o.default_model === null) out.default_model = o.default_model;
  if (typeof o.think === "boolean") out.think = o.think;
  if (typeof o.dictation === "boolean") out.dictation = o.dictation;
  if (typeof o.dictation_hint_seen === "boolean") out.dictation_hint_seen = o.dictation_hint_seen;
  if (o.keep_alive === "0" || o.keep_alive === "5m" || o.keep_alive === "30m" || o.keep_alive === "1h" || o.keep_alive === null) {
    out.keep_alive = o.keep_alive;
  }
  if (typeof o.sidebar_pinned === "boolean") out.sidebar_pinned = o.sidebar_pinned;
  if (o.display_name === null) out.display_name = null;
  else if (typeof o.display_name === "string") {
    const name = o.display_name.replace(/\s+/g, " ").trim().slice(0, DISPLAY_NAME_MAX);
    out.display_name = name || null;
  }
  if (Array.isArray(o.pinned_conversations)) {
    out.pinned_conversations = [...new Set(o.pinned_conversations.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 64))].slice(0, 200);
  }
  if (typeof o.model_options === "object" && o.model_options !== null) {
    const map: Record<string, ModelOptions> = {};
    for (const [model, raw] of Object.entries(o.model_options as Record<string, unknown>)) {
      const clean = sanitizeModelOptions(raw);
      if (model && hasCustomOptions(clean)) map[model] = clean;
    }
    out.model_options = map;
  }
  return out;
}

export const settingsStore = createStore<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  load: async () => {
    const { storage } = getRuntime();
    let stored: unknown = null;
    try {
      stored = await storage.settings.get(KEY);
    } catch {
      /* storage unavailable: defaults */
    }
    const settings = { ...DEFAULT_SETTINGS, ...sanitize(stored) };
    set({ settings, loaded: true });
    return settings;
  },

  update: async (patch) => {
    const { storage } = getRuntime();
    const settings = { ...get().settings, ...sanitize(patch) };
    set({ settings });
    await storage.settings.set(KEY, settings).catch(() => undefined);
    return settings;
  },

  setModelOptions: async (model, options) => {
    const map = { ...get().settings.model_options };
    const clean = options ? sanitizeModelOptions(options) : {};
    if (hasCustomOptions(clean)) map[model] = clean;
    else delete map[model];
    return get().update({ model_options: map });
  },

  setPinned: async (conversationId, pinned) => {
    const rest = get().settings.pinned_conversations.filter((id) => id !== conversationId);
    return get().update({ pinned_conversations: pinned ? [conversationId, ...rest] : rest });
  },

  resetSynced: async () => {
    const defaults = pickSynced(DEFAULT_SETTINGS);
    return get().update(defaults);
  },

  reset: () => set({ settings: DEFAULT_SETTINGS, loaded: false }),
}));
