// Relay frames, client side (SPEC §3.3), with guards for everything the server may send.

import { PROTOCOL_VERSION, type RelayErrorCode } from "./constants";
import { isBool, isInt, isNumber, isRecord, isString, opt, type JsonObject } from "./validate";

// ── Client → Server ──────────────────────────────────────────────────────────

export interface HelloFrame {
  type: "hello";
  v: typeof PROTOCOL_VERSION;
  app: "web";
  version: string;
}
export interface OpenFrame {
  type: "open";
  device_id: string;
}
export interface CloseFrame {
  type: "close";
  device_id: string;
}
export interface DataFrame {
  type: "data";
  device_id: string;
  payload: JsonObject;
}
export interface PairJoinFrame {
  type: "pair_join";
  claim: string;
}
export interface PairMsgFrame {
  type: "pair_msg";
  claim: string;
  payload: JsonObject;
}
export interface PingFrame {
  type: "ping";
  t: number;
}
export interface PongFrame {
  type: "pong";
  t: number;
}

export type ClientFrame =
  | HelloFrame
  | OpenFrame
  | CloseFrame
  | DataFrame
  | PairJoinFrame
  | PairMsgFrame
  | PingFrame
  | PongFrame;

// ── Server → Client ──────────────────────────────────────────────────────────

export interface WelcomeDevice {
  device_id: string;
  name: string;
  online: boolean;
}
export interface WelcomeFrame {
  type: "welcome";
  v: number;
  client_id: string;
  devices: WelcomeDevice[];
  limits: { max_frame_bytes: number };
}
export interface OpenedFrame {
  type: "opened";
  device_id: string;
}
export interface ClosedFrame {
  type: "closed";
  device_id: string;
  reason: string;
}
export interface PairJoinedFrame {
  type: "pair_joined";
  claim: string;
  device_id?: string;
}
export interface PairResultFrame {
  type: "pair_result";
  claim: string;
  ok: boolean;
  device?: { device_id: string; name: string };
  code?: string;
}
export interface DeviceStatusFrame {
  type: "device_status";
  device_id: string;
  online: boolean;
}
export interface ErrorFrame {
  type: "error";
  code: RelayErrorCode | string;
  message?: string;
  ref?: string;
  retry_after_ms?: number;
}

export type ServerFrame =
  | WelcomeFrame
  | OpenedFrame
  | ClosedFrame
  | DataFrame
  | PairJoinedFrame
  | PairMsgFrame
  | PairResultFrame
  | DeviceStatusFrame
  | PingFrame
  | PongFrame
  | ErrorFrame;

export const SERVER_FRAME_TYPES: ReadonlySet<string> = new Set<ServerFrame["type"]>([
  "welcome",
  "opened",
  "closed",
  "data",
  "pair_joined",
  "pair_msg",
  "pair_result",
  "device_status",
  "ping",
  "pong",
  "error",
]);

function isWelcomeDevice(v: unknown): v is WelcomeDevice {
  return isRecord(v) && isString(v.device_id) && isString(v.name) && isBool(v.online);
}

/**
 * Parse one inbound relay frame. Returns `null` for anything malformed or of unknown type;
 * the caller logs and ignores it (unknown fields inside known frames are kept as-is).
 */
export function parseServerFrame(value: unknown): ServerFrame | null {
  if (!isRecord(value) || !isString(value.type)) return null;
  const f = value;
  switch (f.type) {
    case "welcome":
      if (
        isInt(f.v) &&
        isString(f.client_id) &&
        Array.isArray(f.devices) &&
        f.devices.every(isWelcomeDevice) &&
        isRecord(f.limits) &&
        isInt(f.limits.max_frame_bytes)
      ) {
        return f as unknown as WelcomeFrame;
      }
      return null;
    case "opened":
      return isString(f.device_id) ? (f as unknown as OpenedFrame) : null;
    case "closed":
      return isString(f.device_id) && opt(f.reason, isString)
        ? ({ ...f, reason: f.reason ?? "" } as unknown as ClosedFrame)
        : null;
    case "data":
      return isString(f.device_id) && isRecord(f.payload) ? (f as unknown as DataFrame) : null;
    case "pair_joined":
      return isString(f.claim) && opt(f.device_id, isString) ? (f as unknown as PairJoinedFrame) : null;
    case "pair_msg":
      return isString(f.claim) && isRecord(f.payload) ? (f as unknown as PairMsgFrame) : null;
    case "pair_result":
      if (!isString(f.claim) || !isBool(f.ok) || !opt(f.code, isString)) return null;
      if (f.device !== undefined && !(isRecord(f.device) && isString(f.device.device_id) && isString(f.device.name))) {
        return null;
      }
      return f as unknown as PairResultFrame;
    case "device_status":
      return isString(f.device_id) && isBool(f.online) ? (f as unknown as DeviceStatusFrame) : null;
    case "ping":
    case "pong":
      return isNumber(f.t) ? (f as unknown as PingFrame | PongFrame) : null;
    case "error":
      return isString(f.code) && opt(f.message, isString) && opt(f.ref, isString) && opt(f.retry_after_ms, isNumber)
        ? (f as unknown as ErrorFrame)
        : null;
    default:
      return null;
  }
}

export function helloFrame(version: string): HelloFrame {
  return { type: "hello", v: PROTOCOL_VERSION, app: "web", version };
}
