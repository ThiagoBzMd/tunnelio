// SPAKE2-P256-SHA256-HKDF-HMAC (RFC 9382) — side A ("client") per SPEC §4.4.
// Point arithmetic comes from @noble/curves; nothing here is reimplemented by hand.

import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { bigIntToBytes, bytesToBigInt, concat, equalBytes, u64le, utf8, zeroize } from "./bytes";
import { P256_ORDER } from "./code";

type Point = InstanceType<typeof p256.Point>;

export const SPAKE2_M_HEX = "02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f";
export const SPAKE2_N_HEX = "03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49";
export const SPAKE2_M: Point = p256.Point.fromHex(SPAKE2_M_HEX);
export const SPAKE2_N: Point = p256.Point.fromHex(SPAKE2_N_HEX);

export interface Spake2Identities {
  /** Identity of A (the party that uses M and sends first). */
  a: string;
  /** Identity of B. */
  b: string;
  /** Additional authenticated data mixed into the confirmation keys. */
  aad: string;
}

/** Tunnelio identities: browser is A, tray is B (SPEC §0.3, §4.1). */
export const TUNNELIO_SPAKE2: Spake2Identities = { a: "client", b: "device", aad: "tunnelio/v1" };

export class Spake2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Spake2Error";
  }
}

/** Scalar multiplication that tolerates k = 0 (returns the identity) and reduces mod n. */
export function scalarMul(point: Point, k: bigint): Point {
  const r = ((k % P256_ORDER) + P256_ORDER) % P256_ORDER;
  if (r === 0n) return p256.Point.ZERO;
  return point.multiply(r);
}

/** Uniform scalar in [1, n). */
export function randomScalar(): bigint {
  return bytesToBigInt(p256.utils.randomSecretKey());
}

/** SEC1 uncompressed encoding (65 bytes, 0x04 prefix). Throws on the identity. */
export function encodePoint(point: Point): Uint8Array {
  if (point.is0()) throw new Spake2Error("cannot encode the point at infinity");
  return point.toBytes(false);
}

/** Decode and validate a peer element: 65 bytes, 0x04 prefix, on curve, not identity. */
export function decodePoint(bytes: Uint8Array): Point {
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Spake2Error("point must be 65 bytes in uncompressed SEC1 form");
  }
  let point: Point;
  try {
    point = p256.Point.fromBytes(bytes);
    point.assertValidity();
  } catch {
    throw new Spake2Error("point is not on the curve");
  }
  if (point.is0()) throw new Spake2Error("point is the identity");
  return point;
}

export interface Spake2Transcript {
  TT: Uint8Array;
  Ke: Uint8Array;
  Ka: Uint8Array;
  KcA: Uint8Array;
  KcB: Uint8Array;
  cA: Uint8Array;
  cB: Uint8Array;
}

/**
 * Shared transcript/key derivation (RFC 9382 §3.3–§4), used by both sides:
 * TT = len8le(A)||A || len8le(B)||B || len8le(pA)||pA || len8le(pB)||pB || len8le(K)||K || len8le(w)||w
 */
export function spake2Transcript(
  ids: Spake2Identities,
  pA: Uint8Array,
  pB: Uint8Array,
  K: Uint8Array,
  w: bigint,
): Spake2Transcript {
  const a = utf8(ids.a);
  const b = utf8(ids.b);
  const wBytes = bigIntToBytes(w, 32);
  const TT = concat(
    u64le(a.length), a,
    u64le(b.length), b,
    u64le(pA.length), pA,
    u64le(pB.length), pB,
    u64le(K.length), K,
    u64le(wBytes.length), wBytes,
  );
  const digest = sha256(TT);
  const Ke = digest.slice(0, 16);
  const Ka = digest.slice(16, 32);
  const conf = hkdf(sha256, Ka, undefined, concat(utf8("ConfirmationKeys"), utf8(ids.aad)), 32);
  const KcA = conf.slice(0, 16);
  const KcB = conf.slice(16, 32);
  const cA = hmac(sha256, KcA, TT);
  const cB = hmac(sha256, KcB, TT);
  return { TT, Ke, Ka, KcA, KcB, cA, cB };
}

/**
 * Side A of SPAKE2. Usage: `const a = new Spake2A(w); const pA = a.start();` → send `pA`;
 * on `pB, cB`: `const { Ke, cA } = a.finish(pB, cB);` → send `cA`. Any failure throws
 * `Spake2Error` and the instance must be discarded.
 */
export class Spake2A {
  private x: bigint;
  private pA: Uint8Array | null = null;
  private done = false;

  constructor(
    private readonly w: bigint,
    private readonly ids: Spake2Identities = TUNNELIO_SPAKE2,
    x?: bigint,
  ) {
    if (w < 0n || w >= P256_ORDER) throw new Spake2Error("w out of range");
    this.x = x ?? randomScalar();
    if (this.x <= 0n || this.x >= P256_ORDER) throw new Spake2Error("x out of range");
  }

  /** pA = w·M + x·G */
  start(): Uint8Array {
    if (this.pA) return this.pA;
    const X = p256.Point.BASE.multiply(this.x);
    const pA = scalarMul(SPAKE2_M, this.w).add(X);
    this.pA = encodePoint(pA);
    return this.pA;
  }

  /** K = x·(pB − w·N); verify cB; return Ke and cA. */
  finish(pBBytes: Uint8Array, cB: Uint8Array): { Ke: Uint8Array; cA: Uint8Array } {
    if (!this.pA) throw new Spake2Error("start() must be called first");
    if (this.done) throw new Spake2Error("already finished");
    this.done = true;
    const pB = decodePoint(pBBytes);
    const Kpt = pB.subtract(scalarMul(SPAKE2_N, this.w)).multiply(this.x);
    this.x = 0n;
    if (Kpt.is0()) throw new Spake2Error("shared element is the identity");
    const K = encodePoint(Kpt);
    const t = spake2Transcript(this.ids, this.pA, pBBytes, K, this.w);
    if (cB.length !== 32 || !equalBytes(t.cB, cB)) {
      zeroize(t.Ke);
      zeroize(t.Ka);
      throw new Spake2Error("peer confirmation (cB) does not verify");
    }
    zeroize(t.Ka);
    return { Ke: t.Ke, cA: t.cA };
  }
}
