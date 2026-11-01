// @vitest-environment node
// Byte-exact conformance against docs/vectors/vectors.json (SPEC §13).

import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import vectors from "../../docs/vectors/vectors.json";
import {
  bytesToHex,
  hexToBytes,
  utf8,
  utf8Decode,
  bytesToBigInt,
} from "../src/crypto/bytes";
import {
  CROCKFORD_ALPHABET,
  CROCKFORD_CHECK_ALPHABET,
  crockfordDecode,
  crockfordEncode,
  group4,
  normalizeCrockford,
} from "../src/crypto/crockford";
import { normalizePairingCode, pairingCodeToW, splitPairingCode } from "../src/crypto/code";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  SPAKE2_M,
  SPAKE2_N,
  Spake2A,
  Spake2Error,
  decodePoint,
  encodePoint,
  randomScalar,
  scalarMul,
  spake2Transcript,
  type Spake2Identities,
} from "../src/crypto/spake2";
import { pairingIdFromPK, pairingKeyFromKe } from "../src/crypto/pairing";
import {
  deriveSessionKeys,
  helloCBytes,
  helloDBytes,
  transcriptHash,
  x25519PublicKey,
  x25519SharedSecret,
} from "../src/crypto/session";
import {
  DIR_C2D,
  DIR_D2C,
  EnvelopeError,
  envelopeAad,
  envelopeNonce,
  importAesGcmKey,
  openEnvelope,
  sealEnvelope,
  type Direction,
} from "../src/crypto/envelope";
import { uuidToRaw } from "../src/crypto/uuid";
import { authKeyToPassword, authSalt, deriveLoginKeys, deriveMasterKey, normalizeEmail } from "../src/crypto/auth";
import { PAIRINGS_AAD, openPairings, sealPairings } from "../src/crypto/sync";

const hex = (b: Uint8Array) => bytesToHex(b);

describe("V1 pairing code → w", () => {
  const v = vectors.V1_pairing_code_to_w;
  it("normalizes the display code", () => {
    expect(normalizePairingCode(v.code_display)).toBe(v.code_normalized);
    for (const [input, want] of Object.entries(v.normalization_examples)) {
      expect(normalizeCrockford(input)).toBe(want);
    }
    expect(splitPairingCode(v.code_normalized)).toEqual({ claim: "K7M3", secret: "ABCDEFGH" });
  });
  it("hashes and reduces mod n", () => {
    expect(hex(utf8(v.code_normalized))).toBe(v.password_bytes);
    expect(hex(sha512(utf8(v.code_normalized)))).toBe(v.sha512);
    expect(pairingCodeToW(v.code_display).toString(16).padStart(64, "0")).toBe(v.w);
  });
});

// Test-only side B of SPAKE2 (the tray's role), built from the same primitives.
function spake2B(ids: Spake2Identities, w: bigint, y: bigint, pABytes: Uint8Array) {
  const pA = decodePoint(pABytes);
  const pB = scalarMul(SPAKE2_N, w).add(p256.Point.BASE.multiply(y));
  const pBBytes = encodePoint(pB);
  const K = encodePoint(pA.subtract(scalarMul(SPAKE2_M, w)).multiply(y));
  const t = spake2Transcript(ids, pABytes, pBBytes, K, w);
  return { pB: pBBytes, cB: t.cB, cA: t.cA, Ke: t.Ke, K };
}

function checkSpake2Vector(v: typeof vectors.V2_spake2_tunnelio) {
  const ids: Spake2Identities = { a: v.A, b: v.B, aad: v.AAD };
  const w = BigInt("0x" + v.w);
  const x = BigInt("0x" + v.x);
  const y = BigInt("0x" + v.y);
  const a = new Spake2A(w, ids, x);
  const pA = a.start();
  expect(hex(pA)).toBe(v.pA);
  const b = spake2B(ids, w, y, pA);
  expect(hex(b.pB)).toBe(v.pB);
  expect(hex(b.K)).toBe(v.K);
  expect(hex(b.cB)).toBe(v.cB);
  const t = spake2Transcript(ids, pA, b.pB, b.K, w);
  expect(hex(t.TT)).toBe(v.TT);
  expect(hex(t.Ke) + hex(t.Ka)).toBe(v.hash_TT);
  expect(hex(t.Ke)).toBe(v.Ke);
  expect(hex(t.Ka)).toBe(v.Ka);
  expect(hex(t.KcA)).toBe(v.KcA);
  expect(hex(t.KcB)).toBe(v.KcB);
  expect(hex(t.cA)).toBe(v.cA);
  const { Ke, cA } = a.finish(b.pB, b.cB);
  expect(hex(Ke)).toBe(v.Ke);
  expect(hex(cA)).toBe(v.cA);
}

describe("V2 SPAKE2-P256-SHA256-HKDF-HMAC", () => {
  it("reproduces RFC 9382 Appendix B (server/client)", () => {
    checkSpake2Vector(vectors.V2_spake2_rfc9382_check);
  });
  it("reproduces the Tunnelio run (client/device, AAD tunnelio/v1)", () => {
    checkSpake2Vector(vectors.V2_spake2_tunnelio);
  });
  it("round-trips with random scalars and a shared code", () => {
    const w = pairingCodeToW("K7M3-ABCD-EFGH");
    const a = new Spake2A(w);
    const pA = a.start();
    const b = spake2B({ a: "client", b: "device", aad: "tunnelio/v1" }, w, randomScalar(), pA);
    const { Ke, cA } = a.finish(b.pB, b.cB);
    expect(hex(Ke)).toBe(hex(b.Ke));
    expect(hex(cA)).toBe(hex(b.cA));
  });
  it("fails when B used a different code (wrong password)", () => {
    const a = new Spake2A(pairingCodeToW("K7M3-ABCD-EFGH"));
    const pA = a.start();
    const b = spake2B({ a: "client", b: "device", aad: "tunnelio/v1" }, pairingCodeToW("K7M3-ABCD-EFGX"), randomScalar(), pA);
    expect(() => a.finish(b.pB, b.cB)).toThrow(Spake2Error);
  });
  it("rejects malformed and off-curve peer elements", () => {
    const a = new Spake2A(pairingCodeToW("K7M3-ABCD-EFGH"));
    a.start();
    const good = hexToBytes(vectors.V2_spake2_tunnelio.pB);
    const bad = new Uint8Array(good);
    bad[64] = (bad[64] as number) ^ 1;
    expect(() => a.finish(bad, new Uint8Array(32))).toThrow(Spake2Error);
    const b2 = new Spake2A(pairingCodeToW("K7M3-ABCD-EFGH"));
    b2.start();
    expect(() => b2.finish(good.slice(1), new Uint8Array(32))).toThrow(Spake2Error);
    const b3 = new Spake2A(pairingCodeToW("K7M3-ABCD-EFGH"));
    b3.start();
    expect(() => b3.finish(new Uint8Array(65), new Uint8Array(32))).toThrow(Spake2Error);
  });
});

describe("V3 pairing key", () => {
  const v = vectors.V3_pairing_key;
  it("derives PK and pairing_id", () => {
    const PK = pairingKeyFromKe(hexToBytes(v.Ke));
    expect(hex(PK)).toBe(v.PK);
    expect(hex(pairingIdFromPK(PK))).toBe(v.pairing_id);
  });
});

describe("V4 session handshake", () => {
  const v = vectors.V4_session_handshake;
  it("derives directional keys and MACs from both sides", () => {
    const privC = hexToBytes(v.eph_priv_c);
    const privD = hexToBytes(v.eph_priv_d);
    const pubC = x25519PublicKey(privC);
    const pubD = x25519PublicKey(privD);
    expect(hex(pubC)).toBe(v.eph_pub_c);
    expect(hex(pubD)).toBe(v.eph_pub_d);
    const ssC = x25519SharedSecret(privC, pubD);
    const ssD = x25519SharedSecret(privD, pubC);
    expect(hex(ssC)).toBe(v.shared_secret);
    expect(hex(ssD)).toBe(v.shared_secret);
    const pid = hexToBytes(v.pairing_id);
    expect(hex(helloCBytes(pid, pubC))).toBe(v.hello_c_bytes);
    expect(hex(helloDBytes(pubD))).toBe(v.hello_d_bytes);
    expect(hex(transcriptHash(helloCBytes(pid, pubC), helloDBytes(pubD)))).toBe(v.transcript_hash);
    const keys = deriveSessionKeys(hexToBytes(v.PK), pid, pubC, pubD, ssC);
    expect(hex(keys.th)).toBe(v.transcript_hash);
    expect(hex(keys.k_c2d)).toBe(v.k_c2d);
    expect(hex(keys.k_d2c)).toBe(v.k_d2c);
    expect(hex(keys.k_conf_c)).toBe(v.k_conf_c);
    expect(hex(keys.k_conf_d)).toBe(v.k_conf_d);
    expect(hex(keys.mac_c)).toBe(v.mac_c);
    expect(hex(keys.mac_d)).toBe(v.mac_d);
  });
  it("rejects an all-zero shared secret", () => {
    expect(() => x25519SharedSecret(hexToBytes(v.eph_priv_c), new Uint8Array(32))).toThrow();
  });
});

describe("V5 envelope", () => {
  const v = vectors.V5_envelope;
  it("encodes nonce and AAD and matches AES-256-GCM output in both directions", async () => {
    const raw = uuidToRaw(v.device_id);
    expect(hex(raw)).toBe(v.device_id_raw);
    const kC2D = await importAesGcmKey(hexToBytes(v.k_c2d));
    const kD2C = await importAesGcmKey(hexToBytes(v.k_d2c));
    for (const f of v.frames) {
      const dir = f.direction as Direction;
      const key = dir === DIR_C2D ? kC2D : kD2C;
      expect(hex(envelopeNonce(dir, f.counter))).toBe(f.nonce);
      expect(hex(envelopeAad(raw))).toBe(f.aad);
      const sealed = await sealEnvelope(key, dir, f.counter, raw, utf8(f.plaintext));
      expect(hex(sealed.nonce)).toBe(f.nonce);
      expect(hex(sealed.ciphertext)).toBe(f.ciphertext_with_tag);
      const pt = await openEnvelope(key, dir, f.counter, raw, hexToBytes(f.nonce), hexToBytes(f.ciphertext_with_tag));
      expect(utf8Decode(pt)).toBe(f.plaintext);
    }
  });
  it("rejects out-of-order counters, wrong direction keys and bad tags", async () => {
    const raw = uuidToRaw(v.device_id);
    const kC2D = await importAesGcmKey(hexToBytes(v.k_c2d));
    const kD2C = await importAesGcmKey(hexToBytes(v.k_d2c));
    const f = v.frames[1]!;
    const nonce = hexToBytes(f.nonce);
    const ct = hexToBytes(f.ciphertext_with_tag);
    await expect(openEnvelope(kC2D, DIR_C2D, 0, raw, nonce, ct)).rejects.toMatchObject({ code: "E_COUNTER" });
    await expect(openEnvelope(kC2D, DIR_D2C, 1, raw, nonce, ct)).rejects.toMatchObject({ code: "E_COUNTER" });
    await expect(openEnvelope(kD2C, DIR_C2D, 1, raw, nonce, ct)).rejects.toMatchObject({ code: "E_AUTH" });
    const tampered = new Uint8Array(ct);
    tampered[3] = (tampered[3] as number) ^ 0xff;
    await expect(openEnvelope(kC2D, DIR_C2D, 1, raw, nonce, tampered)).rejects.toBeInstanceOf(EnvelopeError);
    const otherDevice = new Uint8Array(raw);
    otherDevice[0] = (otherDevice[0] as number) ^ 1;
    await expect(openEnvelope(kC2D, DIR_C2D, 1, otherDevice, nonce, ct)).rejects.toMatchObject({ code: "E_AUTH" });
  });
});

describe("V6 Crockford base32", () => {
  const v = vectors.V6_crockford_base32;
  it("uses the specified alphabets", () => {
    expect(CROCKFORD_ALPHABET).toBe(v.alphabet);
    expect(CROCKFORD_CHECK_ALPHABET).toBe(v.check_alphabet);
  });
  it("encodes 32 bytes with and without the check symbol", () => {
    const input = hexToBytes(v.input);
    expect(crockfordEncode(input, false)).toBe(v.encoded_52);
    expect(crockfordEncode(input, true)).toBe(v.encoded_53_with_check);
    expect(group4(v.encoded_53_with_check)).toBe(v.display);
  });
  it("keeps bigint helpers consistent", () => {
    expect(bytesToBigInt(hexToBytes("00ff")).toString()).toBe("255");
  });
  it("decodes display/raw forms and validates the check symbol", () => {
    expect(hex(crockfordDecode(v.display, 32, true))).toBe(v.input);
    expect(hex(crockfordDecode(v.encoded_53_with_check.toLowerCase(), 32, true))).toBe(v.input);
    expect(hex(crockfordDecode(v.encoded_52, 32, false))).toBe(v.input);
    const wrongCheck = v.encoded_53_with_check.slice(0, 52) + "3";
    expect(() => crockfordDecode(wrongCheck, 32, true)).toThrow(/check symbol/);
    expect(() => crockfordDecode(v.encoded_52, 32, true)).toThrow(/symbols/);
    const tooBig = "Z" + v.encoded_52.slice(1);
    expect(() => crockfordDecode(tooBig, 32, false)).toThrow(/range/);
  });
});

describe("V8 login keys (one password)", () => {
  const v = vectors.V8_login_keys;
  it("normalizes the e-mail and derives the salt", () => {
    expect(normalizeEmail(v.email)).toBe(v.email_normalized);
    expect(hex(authSalt(v.email))).toBe(v.salt);
    expect(hex(authSalt(v.email_normalized))).toBe(v.salt);
  });
  it("derives master, auth_key, pairings_key byte for byte", async () => {
    const master = await deriveMasterKey(v.password, hexToBytes(v.salt));
    expect(hex(master)).toBe(v.master);
    const keys = await deriveLoginKeys(v.email, v.password);
    expect(hex(keys.salt)).toBe(v.salt);
    expect(hex(keys.authKey)).toBe(v.auth_key);
    expect(hex(keys.pairingsKey)).toBe(v.pairings_key);
    expect(authKeyToPassword(keys.authKey)).toBe(v.auth_key_b64url);
    expect(v.auth_key_b64url).toHaveLength(43);
    // The typed password never appears in what the server sees.
    expect(v.auth_key_b64url).not.toContain(v.password);
  }, 30_000);
  it("seals and opens the synced pairings blob with pairings_key", async () => {
    const key = hexToBytes(v.pairings_key);
    expect(PAIRINGS_AAD).toBe("tunnelio/pairings/v1");
    const plaintext = utf8('{"version":1,"pairings":[]}');
    const nonce = hexToBytes("c0c1c2c3c4c5c6c7c8c9cacb");
    const stored = await sealPairings(key, plaintext, nonce);
    expect(hex(stored.slice(0, 12))).toBe("c0c1c2c3c4c5c6c7c8c9cacb");
    expect(stored).toHaveLength(12 + plaintext.length + 16);
    expect(utf8Decode(await openPairings(key, stored))).toBe('{"version":1,"pairings":[]}');
    const other = new Uint8Array(key);
    other[0] = (other[0] as number) ^ 1;
    await expect(openPairings(other, stored)).rejects.toMatchObject({ code: "E_AUTH" });
  });
  it("device ids still round-trip to raw bytes (V5 helper)", () => {
    expect(hex(uuidToRaw(vectors.V5_envelope.device_id))).toBe(vectors.V5_envelope.device_id_raw);
  });
});
