// Synced preferences (rev. 1.7, SPEC §10.5): the person's preferences (settings.SYNCED_KEYS: theme,
// language, dictation, thinking, default model, model settings, pinned conversations, the name to be
// called by) travel between browsers as ONE blob sealed with the pairings key (crypto/sync.ts,
// `GET/PUT /api/auth/preferences`). The server stores it and cannot read it.
// Plaintext: {"version":1,"updated_at":ISO,"prefs":{…}}.
// The settings store stays the working copy (instant start, no flash); the account copy is the
// reference:
//   - sign-in / start with the key at hand: pull → apply; none or unreadable → ours becomes it;
//   - a synced key changes: pushed (debounced), merged with what other browsers changed meanwhile
//     (only the keys changed here since the last sync overwrite the account copy);
//   - back to the tab after a minute: pull again;
//   - tab hidden or closed with a change waiting: pushed at once (best effort), and the keys still
//     waiting are kept in this browser so the next start pushes them instead of losing them;
//   - sign-out: the person's preferences go back to the defaults in this browser.

import { b64urlDecode, b64urlEncode } from "../crypto/b64url";
import { utf8, utf8Decode, zeroize } from "../crypto/bytes";
import { openPreferences, sealPreferences } from "../crypto/sync";
import type { TimerHandle, Timers } from "../protocol/timers";
import { isRecord } from "../protocol/validate";
import { authStore, getSessionPairingsKey } from "./auth";
import { getRuntime } from "./runtime";
import { DEFAULT_SETTINGS, pickSynced, sanitizeSettings, settingsStore, SYNCED_KEYS, type SyncedKey, type SyncedSettings } from "./settings";
import { nowIso } from "./util";

export const PREFERENCES_VERSION = 1;
const PUSH_DELAY_MS = 800;
const PULL_EVERY_MS = 60_000;
/** Keys changed here and not yet in the account, kept beside the settings so a reload keeps them. */
const PENDING_KEY = "preferences.pending";

export function encodePreferences(prefs: SyncedSettings, updatedAt: string = nowIso()): Uint8Array {
  return utf8(JSON.stringify({ version: PREFERENCES_VERSION, updated_at: updatedAt, prefs }));
}

/** Unknown keys and invalid values are dropped; a malformed document yields `null`. */
export function decodePreferences(plaintext: Uint8Array): { updated_at: string; prefs: Partial<SyncedSettings> } | null {
  let doc: unknown;
  try {
    doc = JSON.parse(utf8Decode(plaintext));
  } catch {
    return null;
  }
  if (!isRecord(doc) || !isRecord(doc.prefs)) return null;
  const clean = sanitizeSettings(doc.prefs) as Record<string, unknown>;
  const prefs: Record<string, unknown> = {};
  for (const k of SYNCED_KEYS) if (k in clean) prefs[k] = clean[k];
  return { updated_at: typeof doc.updated_at === "string" ? doc.updated_at : "", prefs: prefs as Partial<SyncedSettings> };
}

type Pulled = { status: "ok"; prefs: Partial<SyncedSettings> } | { status: "none" } | { status: "stale" };

async function pull(key: Uint8Array): Promise<Pulled> {
  const blob = await getRuntime().api.getPreferences();
  if (!blob) return { status: "none" };
  try {
    const doc = decodePreferences(await openPreferences(key, b64urlDecode(blob.ciphertext)));
    return doc ? { status: "ok", prefs: doc.prefs } : { status: "stale" };
  } catch {
    return { status: "stale" }; // sealed with another key (before a password reset)
  }
}

async function put(key: Uint8Array, prefs: SyncedSettings): Promise<void> {
  const updatedAt = nowIso();
  const ciphertext = b64urlEncode(await sealPreferences(key, encodePreferences(prefs, updatedAt)));
  await getRuntime().api.putPreferences({ timestamp: updatedAt, ciphertext });
}

// ── module state: what the account holds as far as we know, and what changed here since ──
let baseline: SyncedSettings | null = null;
/** Changed here, not yet taken by a sync. */
const dirty = new Set<SyncedKey>();
/** Taken by the sync running now; back to `dirty` if it fails. */
let inFlight: SyncedKey[] = [];
let applying = false;
let lastPull = 0;
let timer: { handle: TimerHandle; timers: Timers } | null = null;
let queue: Promise<unknown> = Promise.resolve();
let pendingRestored = false;

const isSyncedKey = (k: unknown): k is SyncedKey => (SYNCED_KEYS as readonly unknown[]).includes(k);

/** Everything not yet in the account, written beside the settings (a reload or a closed tab keeps it). */
function savePending(): void {
  const waiting = [...new Set([...inFlight, ...dirty])];
  const { storage } = getRuntime();
  const write = waiting.length > 0 ? storage.settings.set(PENDING_KEY, waiting) : storage.settings.delete(PENDING_KEY);
  void write.catch(() => undefined);
}

function markDirty(keys: SyncedKey[]): void {
  for (const k of keys) dirty.add(k);
  savePending();
}

/** A sync takes what is waiting now; changes made while it runs wait for the next one. */
function takeDirty(): SyncedKey[] {
  inFlight = [...new Set([...inFlight, ...dirty])];
  dirty.clear();
  return inFlight;
}

function settle(ok: boolean): void {
  if (!ok) for (const k of inFlight) dirty.add(k);
  inFlight = [];
  savePending();
}

/** The keys a previous page left waiting (closed or reloaded before its push went out). */
async function restorePending(): Promise<void> {
  if (pendingRestored) return;
  pendingRestored = true;
  try {
    const saved = await getRuntime().storage.settings.get(PENDING_KEY);
    if (Array.isArray(saved)) for (const k of saved) if (isSyncedKey(k)) dirty.add(k);
  } catch {
    /* storage unavailable: nothing waiting */
  }
}

/** One sync step at a time (pull/push never interleave). */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function apply(prefs: Partial<SyncedSettings>): Promise<void> {
  applying = true;
  try {
    await settingsStore.getState().update(prefs);
  } finally {
    applying = false;
  }
}

function pickKeys(s: SyncedSettings, keys: Iterable<SyncedKey>): Partial<SyncedSettings> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = s[k];
  return out as Partial<SyncedSettings>;
}

/**
 * Pull the account copy and merge: the account's values, except the keys changed in this browser
 * (they win and are pushed). Nothing readable in the account → ours becomes it.
 */
export function syncPreferences(): Promise<"pulled" | "pushed" | "skipped"> {
  return serial(async () => {
    await restorePending();
    const key = getSessionPairingsKey();
    if (!key) return "skipped";
    const taken = takeDirty();
    let ok = false;
    try {
      const remote = await pull(key);
      lastPull = Date.now();
      const local = pickSynced(settingsStore.getState().settings);
      let result: "pulled" | "pushed";
      if (remote.status === "ok") {
        // Also keep whatever changed here while the pull was on its way (still in `dirty`).
        const merged = { ...local, ...remote.prefs, ...pickKeys(local, [...taken, ...dirty]) } as SyncedSettings;
        await apply(merged);
        if (taken.length > 0) await put(key, merged);
        baseline = merged;
        result = "pulled";
      } else {
        await put(key, local);
        baseline = local;
        result = "pushed";
      }
      ok = true;
      return result;
    } finally {
      settle(ok);
      zeroize(key);
    }
  });
}

/** Seal the whole working copy into the account now (after a password change: the new key). */
export function pushPreferences(): Promise<void> {
  return serial(async () => {
    const key = getSessionPairingsKey();
    if (!key) return;
    takeDirty();
    let ok = false;
    try {
      const local = pickSynced(settingsStore.getState().settings);
      await put(key, local);
      baseline = local;
      ok = true;
    } finally {
      settle(ok);
      zeroize(key);
    }
  });
}

/** Signed out: forget the sync state; the person's preferences go back to the defaults here. */
function cancelTimer(): void {
  if (timer) timer.timers.clearTimeout(timer.handle);
  timer = null;
}

export async function resetPreferencesSync(): Promise<void> {
  cancelTimer();
  baseline = null;
  dirty.clear();
  inFlight = [];
  savePending();
  pendingRestored = true; // what was waiting belonged to the session that just ended
  lastPull = 0;
  await apply(pickSynced(DEFAULT_SETTINGS));
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Watch the settings store (changes made here → pushed) and the tab (back after a while → pull). */
export function startPreferencesSync(): () => void {
  const off = settingsStore.subscribe((state, prev) => {
    if (applying || !state.loaded || !prev.loaded) return;
    const changed = SYNCED_KEYS.filter((k) => !same(state.settings[k], prev.settings[k]));
    if (changed.length === 0) return;
    markDirty(changed);
    if (authStore.getState().status !== "authenticated") return;
    cancelTimer();
    const { timers } = getRuntime();
    timer = {
      timers,
      handle: timers.setTimeout(() => {
        timer = null;
        void syncPreferences().catch((e: unknown) => console.warn("[prefs] sync failed", e));
      }, PUSH_DELAY_MS),
    };
  });
  const flushNow = () => {
    if (!timer) return; // nothing waiting
    cancelTimer();
    void syncPreferences().catch((e: unknown) => console.warn("[prefs] sync failed", e));
  };
  const onVisible = () => {
    if (authStore.getState().status !== "authenticated") return;
    if (document.visibilityState === "hidden") return flushNow();
    if (Date.now() - lastPull < PULL_EVERY_MS) return;
    void syncPreferences().catch((e: unknown) => console.warn("[prefs] sync failed", e));
  };
  const doc = (globalThis as { document?: Document }).document;
  const win = (globalThis as { window?: Window }).window;
  doc?.addEventListener("visibilitychange", onVisible);
  win?.addEventListener("pagehide", flushNow);
  return () => {
    off();
    doc?.removeEventListener("visibilitychange", onVisible);
    win?.removeEventListener("pagehide", flushNow);
    cancelTimer();
  };
}

/** Test hook: a fresh page (the in-memory state is gone; what this browser stored stays). */
export function forgetPreferencesSyncState(): void {
  cancelTimer();
  baseline = null;
  dirty.clear();
  inFlight = [];
  pendingRestored = false;
  lastPull = 0;
}

/** Test hook: what the module believes the account holds. */
export function preferencesBaseline(): SyncedSettings | null {
  return baseline;
}
