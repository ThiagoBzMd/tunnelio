// base64url without padding (RFC 4648 §5) — every binary JSON field uses it (SPEC §0.2).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export function b64urlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += ALPHABET[(n >> 18) & 63] as string;
    out += ALPHABET[(n >> 12) & 63] as string;
    out += ALPHABET[(n >> 6) & 63] as string;
    out += ALPHABET[n & 63] as string;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = (bytes[i] as number) << 16;
    out += ALPHABET[(n >> 18) & 63] as string;
    out += ALPHABET[(n >> 12) & 63] as string;
  } else if (rem === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += ALPHABET[(n >> 18) & 63] as string;
    out += ALPHABET[(n >> 12) & 63] as string;
    out += ALPHABET[(n >> 6) & 63] as string;
  }
  return out;
}

/** Strict decoder: rejects padding, non-alphabet characters and impossible lengths. */
export function b64urlDecode(s: string): Uint8Array {
  const rem = s.length % 4;
  if (rem === 1) throw new Error("invalid base64url length");
  const outLen = Math.floor(s.length / 4) * 3 + (rem === 0 ? 0 : rem - 1);
  const out = new Uint8Array(outLen);
  let o = 0;
  let i = 0;
  const val = (idx: number): number => {
    const c = s.charCodeAt(idx);
    const v = c < 128 ? (LOOKUP[c] as number) : -1;
    if (v < 0) throw new Error("invalid base64url character");
    return v;
  };
  for (; i + 3 < s.length; i += 4) {
    const n = (val(i) << 18) | (val(i + 1) << 12) | (val(i + 2) << 6) | val(i + 3);
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  if (rem === 2) {
    const n = (val(i) << 18) | (val(i + 1) << 12);
    if (n & 0xffff) throw new Error("invalid base64url trailing bits");
    out[o++] = (n >> 16) & 255;
  } else if (rem === 3) {
    const n = (val(i) << 18) | (val(i + 1) << 12) | (val(i + 2) << 6);
    if (n & 0xff) throw new Error("invalid base64url trailing bits");
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
  }
  return out;
}

/** Decode and assert an exact byte length (for fixed-size protocol fields). */
export function b64urlDecodeLen(s: string, length: number): Uint8Array {
  const out = b64urlDecode(s);
  if (out.length !== length) throw new Error(`expected ${length} bytes, got ${out.length}`);
  return out;
}
