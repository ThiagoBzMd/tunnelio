// Encrypted envelope (SPEC §6): AES-256-GCM via WebCrypto, sequential nonces, device_id in AAD.

import { concat, equalBytes, getCrypto, toArrayBuffer, u64be } from "./bytes";

export const DIR_C2D = 0 as const;
export const DIR_D2C = 1 as const;
export type Direction = typeof DIR_C2D | typeof DIR_D2C;

/** Counters are JSON numbers; 2^53 − 1 is the hard limit (SPEC §6.3). */
export const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
export const GCM_TAG_BYTES = 16;
export const GCM_NONCE_BYTES = 12;

export class EnvelopeError extends Error {
  constructor(
    message: string,
    public readonly code: "E_NONCE" | "E_AUTH" | "E_COUNTER" | "E_INVALID",
  ) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/** nonce = dir (1 byte) || 0x00 0x00 0x00 || counter (8 bytes big-endian) */
export function envelopeNonce(direction: Direction, counter: number): Uint8Array {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new EnvelopeError("bad counter", "E_COUNTER");
  return concat(new Uint8Array([direction, 0, 0, 0]), u64be(counter));
}

/** aad = 0x01 || device_id_raw (16 bytes) */
export function envelopeAad(deviceIdRaw: Uint8Array): Uint8Array {
  if (deviceIdRaw.length !== 16) throw new EnvelopeError("device_id must be 16 raw bytes", "E_INVALID");
  return concat(new Uint8Array([0x01]), deviceIdRaw);
}

function subtle(): SubtleCrypto {
  const s = getCrypto().subtle;
  if (!s) throw new Error("WebCrypto subtle is not available");
  return s;
}

export async function importAesGcmKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new EnvelopeError("AES-256 key must be 32 bytes", "E_INVALID");
  return subtle().importKey("raw", toArrayBuffer(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function aesGcmEncrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(aad), tagLength: 128 },
    key,
    toArrayBuffer(plaintext),
  );
  return new Uint8Array(ct);
}

/** Throws `EnvelopeError("E_AUTH")` when the tag does not verify. */
export async function aesGcmDecrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  if (ciphertext.length < GCM_TAG_BYTES) throw new EnvelopeError("ciphertext too short", "E_AUTH");
  try {
    const pt = await subtle().decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(aad), tagLength: 128 },
      key,
      toArrayBuffer(ciphertext),
    );
    return new Uint8Array(pt);
  } catch {
    throw new EnvelopeError("authentication failed", "E_AUTH");
  }
}

export interface SealedEnvelope {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export async function sealEnvelope(
  key: CryptoKey,
  direction: Direction,
  counter: number,
  deviceIdRaw: Uint8Array,
  plaintext: Uint8Array,
): Promise<SealedEnvelope> {
  const nonce = envelopeNonce(direction, counter);
  const ciphertext = await aesGcmEncrypt(key, nonce, envelopeAad(deviceIdRaw), plaintext);
  return { nonce, ciphertext };
}

/**
 * Strict receive: the nonce must equal exactly `expectedCounter` in `direction`
 * (no window, SPEC §6.3). Nonce mismatch → `E_COUNTER`; bad tag → `E_AUTH`.
 */
export async function openEnvelope(
  key: CryptoKey,
  direction: Direction,
  expectedCounter: number,
  deviceIdRaw: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.length !== GCM_NONCE_BYTES) throw new EnvelopeError("nonce must be 12 bytes", "E_NONCE");
  const expected = envelopeNonce(direction, expectedCounter);
  if (!equalBytes(nonce, expected)) throw new EnvelopeError("unexpected nonce/counter", "E_COUNTER");
  return aesGcmDecrypt(key, nonce, envelopeAad(deviceIdRaw), ciphertext);
}
