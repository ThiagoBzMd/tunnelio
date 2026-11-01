// TOTP (RFC 6238, SHA-1, 6 digits, 30 s) for the fake server and the E2E spec. Test-only: the app
// itself never computes codes, it only shows the secret / QR for an authenticator app.

import { hmac } from "@noble/hashes/hmac.js";
import { sha1 } from "@noble/hashes/legacy.js";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[=\s-]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const v = BASE32.indexOf(ch);
    if (v < 0) throw new Error(`invalid base32 symbol ${ch}`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The 6-digit code of `secret` (base32) for the 30 s step containing `nowMs`, shifted by `offset` steps. */
export function totpCode(secret: string, nowMs: number = Date.now(), offset = 0): string {
  const counter = Math.floor(nowMs / 1000 / 30) + offset;
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const mac = hmac(sha1, base32Decode(secret), msg);
  const off = (mac[mac.length - 1] as number) & 0x0f;
  const bin = (((mac[off] as number) & 0x7f) << 24) | ((mac[off + 1] as number) << 16) | ((mac[off + 2] as number) << 8) | (mac[off + 3] as number);
  return String(bin % 1_000_000).padStart(6, "0");
}

/** Accepts the current step and its neighbours (clock drift), like the server. */
export function totpValid(secret: string, code: string, nowMs: number = Date.now()): boolean {
  return [-1, 0, 1].some((o) => totpCode(secret, nowMs, o) === code);
}

export function randomTotpSecret(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}
