// Crockford base32 (SPEC §2.1): normalization, 52+1-symbol encoding of 32-byte keys, grouping.

import { bigIntToBytes, bytesToBigInt } from "./bytes";

export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CROCKFORD_CHECK_ALPHABET = CROCKFORD_ALPHABET + "*~$=U";

const SYMBOL_VALUE = new Map<string, number>();
for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) SYMBOL_VALUE.set(CROCKFORD_ALPHABET[i] as string, i);

/** Uppercase, strip `-` and whitespace, map I/L→1 and O→0. Does not validate symbols. */
export function normalizeCrockford(input: string): string {
  return input
    .toUpperCase()
    .replace(/[-\s]/g, "")
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/O/g, "0");
}

export function isCrockfordSymbol(ch: string): boolean {
  return SYMBOL_VALUE.has(ch);
}

/** True when every character of `s` (already normalized) is in the 32-symbol alphabet. */
export function isCrockfordString(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of s) if (!SYMBOL_VALUE.has(ch)) return false;
  return true;
}

/**
 * Encode bytes as a big-endian integer in base32 (5 bits per symbol, zero-padded on the
 * left) and optionally append the check symbol `n mod 37` (SPEC §2.1).
 */
export function crockfordEncode(data: Uint8Array, withCheck: boolean): string {
  const n = bytesToBigInt(data);
  const nchars = Math.ceil((data.length * 8) / 5);
  let out = "";
  for (let i = 0; i < nchars; i++) {
    const shift = BigInt(5 * (nchars - 1 - i));
    out += CROCKFORD_ALPHABET[Number((n >> shift) & 31n)] as string;
  }
  if (withCheck) out += CROCKFORD_CHECK_ALPHABET[Number(n % 37n)] as string;
  return out;
}

export class CrockfordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrockfordError";
  }
}

/**
 * Decode a (display or raw) code back into `byteLength` bytes, validating the symbol set,
 * the length, that the value fits, and — when `withCheck` — the trailing check symbol.
 */
export function crockfordDecode(code: string, byteLength: number, withCheck: boolean): Uint8Array {
  const s = normalizeCrockford(code);
  const nchars = Math.ceil((byteLength * 8) / 5);
  const expected = nchars + (withCheck ? 1 : 0);
  if (s.length !== expected) {
    throw new CrockfordError(`expected ${expected} symbols, got ${s.length}`);
  }
  let n = 0n;
  for (let i = 0; i < nchars; i++) {
    const v = SYMBOL_VALUE.get(s[i] as string);
    if (v === undefined) throw new CrockfordError(`invalid symbol at position ${i + 1}`);
    n = (n << 5n) | BigInt(v);
  }
  if (n >> BigInt(byteLength * 8) !== 0n) throw new CrockfordError("value out of range");
  if (withCheck) {
    const want = CROCKFORD_CHECK_ALPHABET[Number(n % 37n)];
    if (s[nchars] !== want) throw new CrockfordError("check symbol mismatch");
  }
  return bigIntToBytes(n, byteLength);
}

/** Display grouping: `ABCD-EFGH-…`. */
export function group4(s: string): string {
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += 4) parts.push(s.slice(i, i + 4));
  return parts.join("-");
}
