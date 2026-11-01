// Session handshake payloads (SPEC §5.1) and the envelope wire format (SPEC §6.1), both carried
// inside relay `data.payload`.

import { HANDSHAKE_REJECT_CODES, type PROTOCOL_VERSION, type HandshakeRejectCode } from "./constants";
import { isInt, isOneOf, isRecord, isString, type JsonObject } from "./validate";

export interface HsHello {
  hs: "hello";
  v: typeof PROTOCOL_VERSION;
  pairing_id: string;
  eph_pub: string;
}
export interface HsHelloAck {
  hs: "hello_ack";
  v: number;
  eph_pub: string;
  mac: string;
}
export interface HsConfirm {
  hs: "confirm";
  v: typeof PROTOCOL_VERSION;
  mac: string;
}
export interface HsReject {
  hs: "reject";
  v: number;
  code: HandshakeRejectCode;
}
export type HandshakeOutbound = HsHello | HsConfirm;
export type HandshakeInbound = HsHelloAck | HsReject;

export interface EnvelopeWire {
  v: number;
  device_id: string;
  nonce: string;
  ciphertext: string;
}

export type ClassifiedPayload =
  | { kind: "handshake"; msg: HandshakeInbound }
  | { kind: "envelope"; env: EnvelopeWire }
  | { kind: "invalid"; reason: string };

/** A payload without `hs` and without `ciphertext` is invalid and must be discarded (SPEC §5.1). */
export function classifyPayload(payload: JsonObject): ClassifiedPayload {
  if (isString(payload.hs)) {
    switch (payload.hs) {
      case "hello_ack":
        if (isInt(payload.v) && isString(payload.eph_pub) && isString(payload.mac)) {
          return { kind: "handshake", msg: payload as unknown as HsHelloAck };
        }
        return { kind: "invalid", reason: "malformed hello_ack" };
      case "reject":
        if (isInt(payload.v) && isOneOf(HANDSHAKE_REJECT_CODES, payload.code)) {
          return { kind: "handshake", msg: payload as unknown as HsReject };
        }
        return { kind: "invalid", reason: "malformed reject" };
      default:
        return { kind: "invalid", reason: `unexpected hs ${payload.hs}` };
    }
  }
  if (isString(payload.ciphertext)) {
    if (isInt(payload.v) && isString(payload.device_id) && isString(payload.nonce)) {
      return { kind: "envelope", env: payload as unknown as EnvelopeWire };
    }
    return { kind: "invalid", reason: "malformed envelope" };
  }
  return { kind: "invalid", reason: "payload has neither hs nor ciphertext" };
}

export function isJsonObject(v: unknown): v is JsonObject {
  return isRecord(v);
}
