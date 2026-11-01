// Pairing sync (rev. 1.3): the account's pairings (device_id → PK) travel between browsers as ONE
// blob sealed with the pairings key derived from the password (crypto/auth.ts, crypto/sync.ts;
// `GET/PUT/DELETE /api/devices/pairings`), so a new browser is paired without typing a code.
// Plaintext:
//   {"version":1,"pairings":[{"device_id","pairing_id":b64url(16),"pk":b64url(32),"name","created_at"}]}
// Merge rule: local ∪ remote by device_id, newest `created_at` wins; entries whose device no
// longer exists in the account are dropped; `exclude` removes entries on purpose (forget/remove).
// A blob that does not open (sealed before a password change) counts as empty and is replaced.

import { b64urlDecode, b64urlDecodeLen, b64urlEncode } from "../crypto/b64url";
import { utf8, utf8Decode, zeroize } from "../crypto/bytes";
import { openPairings, sealPairings } from "../crypto/sync";
import type { PairingRecord } from "../lib/storage";
import { isRecord, isString } from "../protocol/validate";
import { deriveLoginKeys, zeroizeLoginKeys } from "../crypto/auth";
import { authStore, getSessionPairingsKey, setSessionPairingsKey } from "./auth";
import { syncPreferences } from "./preferences-sync";
import { getRuntime } from "./runtime";
import { sessionsStore } from "./sessions";
import { nowIso } from "./util";

export const PAIRINGS_BLOB_VERSION = 1;
/** Server cap for the blob (ciphertext, b64url). */
export const PAIRINGS_BLOB_MAX_BYTES = 64 * 1024;

interface WirePairing {
  device_id: string;
  pairing_id: string;
  pk: string;
  name: string;
  created_at: string;
}

function toWire(r: PairingRecord): WirePairing {
  return { device_id: r.device_id, pairing_id: b64urlEncode(r.pairing_id), pk: b64urlEncode(r.pk), name: r.name, created_at: r.created_at };
}

function fromWire(v: unknown): PairingRecord | null {
  if (!isRecord(v) || !isString(v.device_id) || !isString(v.pairing_id) || !isString(v.pk) || !isString(v.name) || !isString(v.created_at)) return null;
  try {
    return { device_id: v.device_id, pairing_id: b64urlDecodeLen(v.pairing_id, 16), pk: b64urlDecodeLen(v.pk, 32), name: v.name, created_at: v.created_at };
  } catch {
    return null;
  }
}

export function encodePairings(records: PairingRecord[]): Uint8Array {
  return utf8(JSON.stringify({ version: PAIRINGS_BLOB_VERSION, pairings: records.map(toWire) }));
}

/** Malformed entries are skipped; a malformed document yields `[]`. */
export function decodePairings(plaintext: Uint8Array): PairingRecord[] {
  let doc: unknown;
  try {
    doc = JSON.parse(utf8Decode(plaintext));
  } catch {
    return [];
  }
  if (!isRecord(doc) || !Array.isArray(doc.pairings)) return [];
  return doc.pairings.map(fromWire).filter((r): r is PairingRecord => r !== null);
}

/**
 * The account's synced pairings: `null` when nothing is synced; `{ records, stale: true }` when
 * the blob does not open with this session's key (sealed under a previous password).
 */
export async function pullPairings(): Promise<{ records: PairingRecord[]; stale: boolean } | null> {
  const key = getSessionPairingsKey();
  if (!key) return null;
  try {
    const { api } = getRuntime();
    const blob = await api.getPairings();
    if (!blob) return null;
    try {
      return { records: decodePairings(await openPairings(key, b64urlDecode(blob.ciphertext))), stale: false };
    } catch {
      return { records: [], stale: true };
    }
  } finally {
    zeroize(key);
  }
}

export async function pushPairings(records: PairingRecord[]): Promise<void> {
  const key = getSessionPairingsKey();
  if (!key) return;
  try {
    const { api } = getRuntime();
    const ciphertext = b64urlEncode(await sealPairings(key, encodePairings(records)));
    if (ciphertext.length > PAIRINGS_BLOB_MAX_BYTES) throw new Error("too many pairings to sync (64 KiB cap)");
    await api.putPairings({ timestamp: nowIso(), ciphertext });
  } finally {
    zeroize(key);
  }
}

export interface SyncOptions {
  /** Device ids to drop from the synced set (forget / remove). */
  exclude?: string[];
  /** Devices that exist on the account (REST list); entries for other devices are dropped. */
  knownDevices?: ReadonlySet<string> | null;
  /** PUT even when the merged set equals the remote one. */
  force?: boolean;
}

export interface SyncResult {
  /** Records written to local storage (new here, or newer than the local copy). */
  imported: PairingRecord[];
  pushed: boolean;
}

const fingerprint = (records: PairingRecord[]): string =>
  records
    .map((r) => `${r.device_id}:${b64urlEncode(r.pairing_id)}:${r.created_at}`)
    .sort()
    .join("|");

/**
 * Merge local and remote pairings, import what is new here, PUT when the server copy changed.
 * No-op (`null`) without a session pairings key (after a reload: the next sign-in syncs).
 * Imported devices get a fresh session on next open.
 */
export async function syncPairings(opts: SyncOptions = {}): Promise<SyncResult | null> {
  const { storage } = getRuntime();
  const local = await storage.pairings.list();
  const pulled = await pullPairings();
  if (pulled === null && !getSessionPairingsKey()) return null;
  const remote = pulled?.records ?? [];
  if (pulled === null && local.length === 0 && !opts.force) return { imported: [], pushed: false };

  const merged = new Map<string, PairingRecord>();
  for (const r of remote) merged.set(r.device_id, r);
  for (const l of local) {
    const cur = merged.get(l.device_id);
    if (!cur || l.created_at > cur.created_at) merged.set(l.device_id, l);
  }
  for (const id of opts.exclude ?? []) merged.delete(id);
  if (opts.knownDevices) {
    for (const id of [...merged.keys()]) if (!opts.knownDevices.has(id)) merged.delete(id);
  }

  const localById = new Map(local.map((l) => [l.device_id, l]));
  const imported: PairingRecord[] = [];
  for (const [id, rec] of merged) {
    const mine = localById.get(id);
    if (mine && mine.created_at >= rec.created_at) continue;
    await storage.pairings.put(rec);
    sessionsStore.getState().close(id);
    imported.push(rec);
  }

  const next = [...merged.values()];
  const changed = fingerprint(next) !== fingerprint(remote) || pulled?.stale === true;
  const pushed = changed || opts.force === true;
  if (pushed) await pushPairings(next);
  return { imported, pushed };
}

/**
 * Signed in but without the pairings key — a home-screen app on iOS (its own storage), a browser
 * that dropped its local data while the cookie survived: derive the keys from the password,
 * prove them on the synced blob (it only opens with the right key), keep the key for this
 * session and import the pairings. Nothing is sent to the server besides the usual GET/PUT.
 */
export async function unlockPairings(password: string): Promise<"ok" | "wrong_password" | "nothing"> {
  const me = authStore.getState().me;
  if (!me) return "nothing";
  const { storage } = getRuntime();
  const keys = await deriveLoginKeys(me.email, password);
  try {
    setSessionPairingsKey(keys.pairingsKey);
    const pulled = await pullPairings();
    if (pulled === null || pulled.stale) {
      setSessionPairingsKey(null);
      return pulled === null ? "nothing" : "wrong_password";
    }
    await storage.session.setPairingsKey(keys.pairingsKey).catch(() => undefined);
    authStore.setState({ pairingsKeyPresent: true });
    await syncPairings();
    // The same key opens the synced preferences (theme, name…): bring them too.
    await syncPreferences().catch(() => undefined);
    return "ok";
  } finally {
    zeroizeLoginKeys(keys);
  }
}
