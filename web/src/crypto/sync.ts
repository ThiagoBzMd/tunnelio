// Synced pairings blob (rev. 1.3): the account's pairings travel between browsers as one AES-256-GCM
// blob sealed with `pairings_key` (crypto/auth.ts), so a new browser is paired without a code.
//   stored = nonce(12) || AES-256-GCM(pairings_key, nonce, aad = "tunnelio/pairings/v1", plaintext)
// The server (GET/PUT/DELETE /api/devices/pairings) only ever sees `stored`.

import { concat, randomBytes, utf8 } from "./bytes";
import { aesGcmDecrypt, aesGcmEncrypt, EnvelopeError, GCM_NONCE_BYTES, GCM_TAG_BYTES, importAesGcmKey } from "./envelope";

export const PAIRINGS_AAD = "tunnelio/pairings/v1";

export async function sealPairings(key: Uint8Array, plaintext: Uint8Array, nonce: Uint8Array = randomBytes(GCM_NONCE_BYTES)): Promise<Uint8Array> {
  if (nonce.length !== GCM_NONCE_BYTES) throw new Error("pairings nonce must be 12 bytes");
  const k = await importAesGcmKey(key);
  return concat(nonce, await aesGcmEncrypt(k, nonce, utf8(PAIRINGS_AAD), plaintext));
}

/** Throws `EnvelopeError("E_AUTH")` for a blob sealed with another key (e.g. before a password change). */
export async function openPairings(key: Uint8Array, stored: Uint8Array): Promise<Uint8Array> {
  if (stored.length < GCM_NONCE_BYTES + GCM_TAG_BYTES) throw new EnvelopeError("pairings blob too short", "E_INVALID");
  const k = await importAesGcmKey(key);
  return aesGcmDecrypt(k, stored.slice(0, GCM_NONCE_BYTES), utf8(PAIRINGS_AAD), stored.slice(GCM_NONCE_BYTES));
}

// Synced preferences (rev. 1.7, SPEC §10.5): same construction and key, another AAD, so a pairings
// blob can never be opened as preferences (or the other way round).
//   stored = nonce(12) || AES-256-GCM(pairings_key, nonce, aad = "tunnelio/preferences/v1", plaintext)
export const PREFERENCES_AAD = "tunnelio/preferences/v1";

export async function sealPreferences(key: Uint8Array, plaintext: Uint8Array, nonce: Uint8Array = randomBytes(GCM_NONCE_BYTES)): Promise<Uint8Array> {
  if (nonce.length !== GCM_NONCE_BYTES) throw new Error("preferences nonce must be 12 bytes");
  const k = await importAesGcmKey(key);
  return concat(nonce, await aesGcmEncrypt(k, nonce, utf8(PREFERENCES_AAD), plaintext));
}

/** Throws `EnvelopeError("E_AUTH")` for a blob sealed with another key (e.g. before a password reset). */
export async function openPreferences(key: Uint8Array, stored: Uint8Array): Promise<Uint8Array> {
  if (stored.length < GCM_NONCE_BYTES + GCM_TAG_BYTES) throw new EnvelopeError("preferences blob too short", "E_INVALID");
  const k = await importAesGcmKey(key);
  return aesGcmDecrypt(k, stored.slice(0, GCM_NONCE_BYTES), utf8(PREFERENCES_AAD), stored.slice(GCM_NONCE_BYTES));
}
