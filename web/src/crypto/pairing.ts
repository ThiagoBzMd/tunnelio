// Pairing key and pairing_id derivation (SPEC §4.5, §4.6).

import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { concat, utf8 } from "./bytes";

export const PAIRING_KEY_INFO = "tunnelio/v1/pairing-key";
export const PAIRING_ID_LABEL = "tunnelio/v1/pairing-id";

/** PK = HKDF-SHA256(ikm = Ke, salt = ∅, info = "tunnelio/v1/pairing-key", L = 32) */
export function pairingKeyFromKe(Ke: Uint8Array): Uint8Array {
  return hkdf(sha256, Ke, undefined, utf8(PAIRING_KEY_INFO), 32);
}

/** pairing_id = SHA-256("tunnelio/v1/pairing-id" || PK)[0:16] */
export function pairingIdFromPK(PK: Uint8Array): Uint8Array {
  return sha256(concat(utf8(PAIRING_ID_LABEL), PK)).slice(0, 16);
}
