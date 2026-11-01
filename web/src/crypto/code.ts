// Pairing code (SPEC §2.1, §4.3): `CCCC-SSSS-SSSS` → claim/secret split and SPAKE2 scalar w.

import { sha512 } from "@noble/hashes/sha2.js";
import { p256 } from "@noble/curves/nist.js";
import { bytesToBigInt, utf8 } from "./bytes";
import { CrockfordError, group4, isCrockfordString, normalizeCrockford } from "./crockford";

export const PAIRING_CODE_LENGTH = 12;
export const CLAIM_LENGTH = 4;
export const SECRET_LENGTH = 8;

/** Order of P-256 (`n`). */
export const P256_ORDER: bigint = p256.Point.Fn.ORDER;

/** Normalize user input into the 12-symbol canonical form; throws on bad length/symbols. */
export function normalizePairingCode(input: string): string {
  const s = normalizeCrockford(input);
  if (s.length !== PAIRING_CODE_LENGTH) {
    throw new CrockfordError(`pairing code must have ${PAIRING_CODE_LENGTH} symbols`);
  }
  if (!isCrockfordString(s)) throw new CrockfordError("pairing code has invalid symbols");
  return s;
}

export function splitPairingCode(normalized: string): { claim: string; secret: string } {
  return { claim: normalized.slice(0, CLAIM_LENGTH), secret: normalized.slice(CLAIM_LENGTH) };
}

export function formatPairingCode(normalized: string): string {
  return group4(normalized);
}

/** `w = int_be(SHA-512(ASCII(normalized code))) mod n` (SPEC §4.3). */
export function pairingCodeToW(code: string): bigint {
  const pw = utf8(normalizePairingCode(code));
  return bytesToBigInt(sha512(pw)) % P256_ORDER;
}
