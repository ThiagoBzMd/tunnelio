// E2E session handshake derivation (SPEC §5): X25519 (via @noble, §14.4) + HKDF + HMAC.

import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { expand } from "@noble/hashes/hkdf.js";
import { concat, isAllZero, utf8 } from "./bytes";

export const SESSION_LABEL_C2D = "tunnelio/v1/c2d";
export const SESSION_LABEL_D2C = "tunnelio/v1/d2c";
export const SESSION_LABEL_CONFIRM_C = "tunnelio/v1/confirm-c";
export const SESSION_LABEL_CONFIRM_D = "tunnelio/v1/confirm-d";

export class SessionCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCryptoError";
  }
}

export interface EphemeralKeyPair {
  priv: Uint8Array;
  pub: Uint8Array;
}

export function generateEphemeral(): EphemeralKeyPair {
  const priv = x25519.utils.randomSecretKey();
  return { priv, pub: x25519.getPublicKey(priv) };
}

export function x25519PublicKey(priv: Uint8Array): Uint8Array {
  return x25519.getPublicKey(priv);
}

/** X25519(priv, peerPub); rejects an all-zero output (RFC 7748 §6.1). */
export function x25519SharedSecret(priv: Uint8Array, peerPub: Uint8Array): Uint8Array {
  if (priv.length !== 32 || peerPub.length !== 32) {
    throw new SessionCryptoError("X25519 keys must be 32 bytes");
  }
  let ss: Uint8Array;
  try {
    ss = x25519.getSharedSecret(priv, peerPub);
  } catch {
    throw new SessionCryptoError("invalid X25519 public key");
  }
  if (isAllZero(ss)) throw new SessionCryptoError("X25519 produced an all-zero shared secret");
  return ss;
}

/** hello_c_bytes = 0x01 || pairing_id (16) || eph_pub_c (32) */
export function helloCBytes(pairingId: Uint8Array, ephPubC: Uint8Array): Uint8Array {
  if (pairingId.length !== 16 || ephPubC.length !== 32) throw new SessionCryptoError("bad hello_c fields");
  return concat(new Uint8Array([0x01]), pairingId, ephPubC);
}

/** hello_d_bytes = 0x01 || eph_pub_d (32) */
export function helloDBytes(ephPubD: Uint8Array): Uint8Array {
  if (ephPubD.length !== 32) throw new SessionCryptoError("bad hello_d fields");
  return concat(new Uint8Array([0x01]), ephPubD);
}

export function transcriptHash(helloC: Uint8Array, helloD: Uint8Array): Uint8Array {
  return sha256(concat(helloC, helloD));
}

export interface SessionKeys {
  th: Uint8Array;
  k_c2d: Uint8Array;
  k_d2c: Uint8Array;
  k_conf_c: Uint8Array;
  k_conf_d: Uint8Array;
  mac_c: Uint8Array;
  mac_d: Uint8Array;
}

/**
 * prk = HMAC-SHA256(PK, ss); k_* = HKDF-Expand(prk, label || th, 32); mac_* = HMAC(k_conf_*, th).
 * The caller must zeroize `ss` and the ephemeral private key afterwards.
 */
export function deriveSessionKeys(
  PK: Uint8Array,
  pairingId: Uint8Array,
  ephPubC: Uint8Array,
  ephPubD: Uint8Array,
  ss: Uint8Array,
): SessionKeys {
  if (PK.length !== 32) throw new SessionCryptoError("PK must be 32 bytes");
  const th = transcriptHash(helloCBytes(pairingId, ephPubC), helloDBytes(ephPubD));
  const prk = hmac(sha256, PK, ss);
  const k_c2d = expand(sha256, prk, concat(utf8(SESSION_LABEL_C2D), th), 32);
  const k_d2c = expand(sha256, prk, concat(utf8(SESSION_LABEL_D2C), th), 32);
  const k_conf_c = expand(sha256, prk, concat(utf8(SESSION_LABEL_CONFIRM_C), th), 32);
  const k_conf_d = expand(sha256, prk, concat(utf8(SESSION_LABEL_CONFIRM_D), th), 32);
  prk.fill(0);
  const mac_d = hmac(sha256, k_conf_d, th);
  const mac_c = hmac(sha256, k_conf_c, th);
  return { th, k_c2d, k_d2c, k_conf_c, k_conf_d, mac_c, mac_d };
}
