// SPAKE2 messages carried in `pair_msg.payload` (SPEC §4.4).

import { type PROTOCOL_VERSION } from "./constants";
import { isInt, isRecord, isString, type JsonObject } from "./validate";

export interface Pake1 {
  t: "pake1";
  v: typeof PROTOCOL_VERSION;
  pA: string;
}
export interface Pake2 {
  t: "pake2";
  v: number;
  pB: string;
  cB: string;
}
export interface Pake3 {
  t: "pake3";
  v: typeof PROTOCOL_VERSION;
  cA: string;
}

export function parsePake2(payload: JsonObject): Pake2 | null {
  if (payload.t !== "pake2") return null;
  if (!isInt(payload.v) || !isString(payload.pB) || !isString(payload.cB)) return null;
  return payload as unknown as Pake2;
}

export function isPakePayload(v: unknown): v is JsonObject & { t: string } {
  return isRecord(v) && isString(v.t);
}
