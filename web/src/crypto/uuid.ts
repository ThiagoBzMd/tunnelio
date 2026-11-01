// UUID helpers: canonical lowercase text ↔ 16 raw bytes (device_id in the envelope AAD, SPEC §6).

import { bytesToHex, hexToBytes, randomBytes } from "./bytes";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export function uuidToRaw(uuid: string): Uint8Array {
  const s = uuid.toLowerCase();
  if (!UUID_RE.test(s)) throw new Error("invalid UUID");
  return hexToBytes(s.replace(/-/g, ""));
}

export function rawToUuid(raw: Uint8Array): string {
  if (raw.length !== 16) throw new Error("UUID raw form must be 16 bytes");
  const h = bytesToHex(raw);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Random UUID v4 (CSPRNG). */
export function randomUuid(): string {
  const b = randomBytes(16);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  return rawToUuid(b);
}
