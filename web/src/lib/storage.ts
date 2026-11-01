// Local persistence (SPEC §4.7): pairings (PK per device), settings, and the session's pairings
// key (kept while signed in so a reload keeps syncing; cleared at sign-out). Two implementations:
// IndexedDB via `idb` (browser) and in-memory (tests, Node CLI base).

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export interface PairingRecord {
  /** Device UUID (canonical lowercase). */
  device_id: string;
  /** 16 raw bytes (SPEC §4.6). */
  pairing_id: Uint8Array;
  /** 32-byte pairing key. Never logged, never leaves the storage layer except into DeviceSession. */
  pk: Uint8Array;
  name: string;
  created_at: string;
}

export interface PairingStore {
  list(): Promise<PairingRecord[]>;
  get(deviceId: string): Promise<PairingRecord | null>;
  put(record: PairingRecord): Promise<void>;
  delete(deviceId: string): Promise<void>;
  clear(): Promise<void>;
}

export interface SessionStore {
  /** The pairings key derived at sign-in (crypto/auth.ts), remembered until sign-out. */
  getPairingsKey(): Promise<Uint8Array | null>;
  setPairingsKey(key: Uint8Array): Promise<void>;
  clearPairingsKey(): Promise<void>;
}

export interface SettingsStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  all(): Promise<Record<string, unknown>>;
}

export interface AppStorage {
  pairings: PairingStore;
  session: SessionStore;
  settings: SettingsStore;
  close(): Promise<void>;
}

const copy = (b: Uint8Array): Uint8Array => new Uint8Array(b);

function cloneRecord(r: PairingRecord): PairingRecord {
  return { ...r, pairing_id: copy(r.pairing_id), pk: copy(r.pk) };
}

// ── In-memory ────────────────────────────────────────────────────────────────

export function createMemoryStorage(): AppStorage {
  const pairings = new Map<string, PairingRecord>();
  let pairingsKey: Uint8Array | null = null;
  const settings = new Map<string, unknown>();
  return {
    pairings: {
      async list() {
        return [...pairings.values()].map(cloneRecord);
      },
      async get(id) {
        const r = pairings.get(id);
        return r ? cloneRecord(r) : null;
      },
      async put(r) {
        pairings.set(r.device_id, cloneRecord(r));
      },
      async delete(id) {
        pairings.delete(id);
      },
      async clear() {
        pairings.clear();
      },
    },
    session: {
      async getPairingsKey() {
        return pairingsKey ? copy(pairingsKey) : null;
      },
      async setPairingsKey(k) {
        pairingsKey = copy(k);
      },
      async clearPairingsKey() {
        if (pairingsKey) pairingsKey.fill(0);
        pairingsKey = null;
      },
    },
    settings: {
      async get(k) {
        return settings.get(k);
      },
      async set(k, v) {
        settings.set(k, v);
      },
      async delete(k) {
        settings.delete(k);
      },
      async all() {
        return Object.fromEntries(settings);
      },
    },
    async close() {
      /* nothing to release */
    },
  };
}

// ── IndexedDB ────────────────────────────────────────────────────────────────

export const DB_NAME = "tunnelio";
/** v2 (rev. 1.3): the pre-rev. 1.3 "vault" object store (server-side conversations, removed) is deleted on upgrade, with the key it held; "session" added. */
export const DB_VERSION = 2;
const PAIRINGS_KEY_ROW = "pairings_key";

interface TunnelioDB extends DBSchema {
  pairings: { key: string; value: PairingRecord };
  session: { key: string; value: Uint8Array };
  settings: { key: string; value: unknown };
}

export function createIndexedDbStorage(name: string = DB_NAME): AppStorage {
  let dbPromise: Promise<IDBPDatabase<TunnelioDB>> | null = null;
  const db = (): Promise<IDBPDatabase<TunnelioDB>> => {
    dbPromise ??= openDB<TunnelioDB>(name, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains("pairings")) d.createObjectStore("pairings", { keyPath: "device_id" });
        if (!d.objectStoreNames.contains("settings")) d.createObjectStore("settings");
        if (!d.objectStoreNames.contains("session")) d.createObjectStore("session");
        // Migration from a v1 database: the store no longer exists in the schema, hence the cast.
        if ((d.objectStoreNames as DOMStringList).contains("vault")) d.deleteObjectStore("vault" as never);
      },
      blocking() {
        // Another tab upgraded the schema: let it proceed; we reopen lazily.
        void dbPromise?.then((d) => d.close());
        dbPromise = null;
      },
    });
    return dbPromise;
  };
  return {
    pairings: {
      async list() {
        return (await (await db()).getAll("pairings")).map(cloneRecord);
      },
      async get(id) {
        const r = await (await db()).get("pairings", id);
        return r ? cloneRecord(r) : null;
      },
      async put(r) {
        await (await db()).put("pairings", cloneRecord(r));
      },
      async delete(id) {
        await (await db()).delete("pairings", id);
      },
      async clear() {
        await (await db()).clear("pairings");
      },
    },
    session: {
      async getPairingsKey() {
        const k = await (await db()).get("session", PAIRINGS_KEY_ROW);
        return k ? copy(k) : null;
      },
      async setPairingsKey(k) {
        await (await db()).put("session", copy(k), PAIRINGS_KEY_ROW);
      },
      async clearPairingsKey() {
        await (await db()).delete("session", PAIRINGS_KEY_ROW);
      },
    },
    settings: {
      async get(k) {
        return (await db()).get("settings", k);
      },
      async set(k, v) {
        await (await db()).put("settings", v, k);
      },
      async delete(k) {
        await (await db()).delete("settings", k);
      },
      async all() {
        const d = await db();
        const keys = await d.getAllKeys("settings");
        const values = await d.getAll("settings");
        const out: Record<string, unknown> = {};
        keys.forEach((k, i) => {
          out[String(k)] = values[i];
        });
        return out;
      },
    },
    async close() {
      if (dbPromise) {
        (await dbPromise).close();
        dbPromise = null;
      }
    },
  };
}
