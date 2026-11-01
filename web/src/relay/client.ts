// RelayClient — WebSocket client for `/ws/client` (SPEC §3.3, §3.5, §3.7).
// Transport only: no crypto here. Injectable WebSocket constructor and timers for tests/Node.

import {
  CLOSE_CODES,
  RELAY_SUBPROTOCOL,
  TIMEOUTS,
} from "../protocol/constants";
import {
  helloFrame,
  parseServerFrame,
  type ClientFrame,
  type ClosedFrame,
  type DataFrame,
  type DeviceStatusFrame,
  type ErrorFrame,
  type OpenedFrame,
  type PairJoinedFrame,
  type PairMsgFrame,
  type PairResultFrame,
  type WelcomeFrame,
} from "../protocol/relay";
import type { JsonObject } from "../protocol/validate";
import { realTimers, type TimerHandle, type Timers } from "../protocol/timers";
import { TypedEmitter } from "./events";

/** Structural subset of the WHATWG WebSocket that both the browser and `ws` satisfy. */
export interface WebSocketLike {
  readonly readyState: number;
  readonly protocol: string;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketCtor = new (url: string, protocols: string[]) => WebSocketLike;

const WS_OPEN = 1;

export type RelayState = "idle" | "connecting" | "ready" | "waiting" | "closed";

export interface RelayStateChange {
  state: RelayState;
  /** Consecutive failed attempts (0 when healthy). */
  attempt: number;
  /** Delay before the next attempt when `state === "waiting"`. */
  delayMs?: number;
}

export interface RelayEvents {
  state: RelayStateChange;
  welcome: WelcomeFrame;
  opened: OpenedFrame;
  closed: ClosedFrame;
  data: DataFrame;
  pair_joined: PairJoinedFrame;
  pair_msg: PairMsgFrame;
  pair_result: PairResultFrame;
  device_status: DeviceStatusFrame;
  /** Relay `error` frames, plus synthesized ones for close codes 4003/4004. */
  error: ErrorFrame;
  disconnected: { code: number; reason: string; willReconnect: boolean };
  /** Close 4001: the login session is gone; no reconnect until `connect()` is called again. */
  auth_lost: { code: number; reason: string };
  /** Close 4002 (protocol violation): no reconnect, needs a human. */
  fatal: { code: number; reason: string };
}

export type RelayLogLevel = "debug" | "info" | "warn" | "error";
export type RelayLogger = (level: RelayLogLevel, message: string, extra?: unknown) => void;

export interface RelayClientOptions {
  url: string;
  appVersion: string;
  WebSocket?: WebSocketCtor;
  timers?: Timers;
  /** Uniform [0,1) source for the jitter; injectable for tests. */
  random?: () => number;
  pingIntervalMs?: number;
  pongDeadMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  stableMs?: number;
  /** How long to wait for `welcome` after the socket opens. */
  welcomeTimeoutMs?: number;
  log?: RelayLogger;
}

export class RelayError extends Error {
  constructor(
    public readonly code: "E_NOT_CONNECTED" | "E_CLOSED" | "E_AUTH" | "E_TIMEOUT" | "E_FATAL",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "RelayError";
  }
}

function defaultWebSocket(): WebSocketCtor {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (!ctor) throw new Error("no WebSocket implementation available; pass options.WebSocket");
  return ctor as WebSocketCtor;
}

const defaultLog: RelayLogger = (level, message, extra) => {
  if (level === "debug") return;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  if (extra === undefined) fn(`[relay] ${message}`);
  else fn(`[relay] ${message}`, extra);
};

export class RelayClient extends TypedEmitter<RelayEvents> {
  private readonly url: string;
  private readonly appVersion: string;
  private readonly WS: WebSocketCtor;
  private readonly timers: Timers;
  private readonly random: () => number;
  private readonly pingIntervalMs: number;
  private readonly pongDeadMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly stableMs: number;
  private readonly welcomeTimeoutMs: number;
  private readonly log: RelayLogger;

  private socket: WebSocketLike | null = null;
  private _state: RelayState = "idle";
  private _clientId: string | null = null;
  private _limits: WelcomeFrame["limits"] | null = null;
  private attempt = 0;
  private manualClose = false;

  private pingTimer: TimerHandle | null = null;
  private deadTimer: TimerHandle | null = null;
  private stableTimer: TimerHandle | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private welcomeTimer: TimerHandle | null = null;

  constructor(opts: RelayClientOptions) {
    super();
    this.url = opts.url;
    this.appVersion = opts.appVersion;
    this.WS = opts.WebSocket ?? defaultWebSocket();
    this.timers = opts.timers ?? realTimers;
    this.random = opts.random ?? Math.random;
    this.pingIntervalMs = opts.pingIntervalMs ?? TIMEOUTS.PING_INTERVAL_MS;
    this.pongDeadMs = opts.pongDeadMs ?? TIMEOUTS.PONG_DEAD_MS;
    this.backoffBaseMs = opts.backoffBaseMs ?? TIMEOUTS.BACKOFF_BASE_MS;
    this.backoffMaxMs = opts.backoffMaxMs ?? TIMEOUTS.BACKOFF_MAX_MS;
    this.stableMs = opts.stableMs ?? TIMEOUTS.BACKOFF_STABLE_MS;
    this.welcomeTimeoutMs = opts.welcomeTimeoutMs ?? 15_000;
    this.log = opts.log ?? defaultLog;
  }

  get state(): RelayState {
    return this._state;
  }
  get clientId(): string | null {
    return this._clientId;
  }
  get limits(): WelcomeFrame["limits"] | null {
    return this._limits;
  }
  get isReady(): boolean {
    return this._state === "ready";
  }

  /** Open the connection (idempotent). After `disconnect()`/4001 this starts over. */
  connect(): void {
    if (this._state === "connecting" || this._state === "ready" || this._state === "waiting") return;
    this.manualClose = false;
    this.attempt = 0;
    this.dial();
  }

  /** Close for good (code 1000); no reconnect. */
  disconnect(): void {
    this.manualClose = true;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      this.detach(s);
      try {
        s.close(1000, "client closing");
      } catch {
        /* already closed */
      }
    }
    const was = this._state;
    this._clientId = null;
    this.setState("closed");
    if (was !== "closed" && was !== "idle") this.emit("disconnected", { code: 1000, reason: "client closing", willReconnect: false });
  }

  /** Resolves once `welcome` has been received; rejects on auth loss/fatal/timeout. */
  whenReady(timeoutMs = 30_000): Promise<void> {
    if (this._state === "ready") return Promise.resolve();
    // `idle` = connect() not called yet (e.g. a deep link racing the app bootstrap): wait for it,
    // bounded by the timeout. `closed` = deliberate/fatal close: fail fast.
    if (this._state === "closed") {
      return Promise.reject(new RelayError("E_NOT_CONNECTED", "relay is not connected"));
    }
    return new Promise<void>((resolve, reject) => {
      const offs: (() => void)[] = [];
      const done = (fn: () => void) => {
        for (const off of offs) off();
        this.timers.clearTimeout(timer);
        fn();
      };
      const timer = this.timers.setTimeout(() => done(() => reject(new RelayError("E_TIMEOUT", "relay not ready"))), timeoutMs);
      offs.push(this.on("state", (s) => {
        if (s.state === "ready") done(resolve);
        else if (s.state === "closed") done(() => reject(new RelayError("E_CLOSED", "relay closed")));
      }));
    });
  }

  /** Send any client frame. Requires `ready` except for `hello`/`ping`/`pong`. */
  send(frame: ClientFrame): void {
    const s = this.socket;
    if (!s || s.readyState !== WS_OPEN) throw new RelayError("E_NOT_CONNECTED", "socket is not open");
    if (this._state !== "ready" && frame.type !== "hello" && frame.type !== "ping" && frame.type !== "pong") {
      throw new RelayError("E_NOT_CONNECTED", "relay handshake not complete");
    }
    s.send(JSON.stringify(frame));
  }

  openSession(deviceId: string): void {
    this.send({ type: "open", device_id: deviceId });
  }
  closeSession(deviceId: string): void {
    this.send({ type: "close", device_id: deviceId });
  }
  sendData(deviceId: string, payload: JsonObject): void {
    this.send({ type: "data", device_id: deviceId, payload });
  }
  pairJoin(claim: string): void {
    this.send({ type: "pair_join", claim });
  }
  pairMsg(claim: string, payload: JsonObject): void {
    this.send({ type: "pair_msg", claim, payload });
  }

  // ── internals ────────────────────────────────────────────────────────────

  private setState(state: RelayState, delayMs?: number): void {
    if (this._state === state && delayMs === undefined) return;
    this._state = state;
    const change: RelayStateChange = { state, attempt: this.attempt };
    if (delayMs !== undefined) change.delayMs = delayMs;
    this.emit("state", change);
  }

  private dial(): void {
    this.reconnectTimer = null;
    let socket: WebSocketLike;
    try {
      socket = new this.WS(this.url, [RELAY_SUBPROTOCOL]);
    } catch (e) {
      this.log("warn", "WebSocket constructor failed", e);
      this.handleClose(1006, "constructor failed");
      return;
    }
    this.socket = socket;
    this.setState("connecting");
    socket.onopen = () => this.handleOpen(socket);
    socket.onmessage = (ev) => this.handleMessage(socket, ev.data);
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.handleClose(ev.code, ev.reason ?? "");
    };
    socket.onerror = () => {
      // The close event that follows carries the real information.
      this.log("debug", "socket error");
    };
  }

  private handleOpen(socket: WebSocketLike): void {
    if (this.socket !== socket) return;
    if (socket.protocol && socket.protocol !== RELAY_SUBPROTOCOL) {
      this.log("error", `server selected subprotocol ${socket.protocol}`);
      this.drop(socket, CLOSE_CODES.PROTOCOL_VIOLATION, "bad subprotocol");
      return;
    }
    try {
      socket.send(JSON.stringify(helloFrame(this.appVersion)));
    } catch (e) {
      this.log("warn", "hello failed", e);
      this.drop(socket, 1006, "hello failed");
      return;
    }
    this.welcomeTimer = this.timers.setTimeout(() => {
      this.log("warn", "no welcome from relay");
      this.drop(socket, 4000, "welcome timeout");
    }, this.welcomeTimeoutMs);
  }

  private handleMessage(socket: WebSocketLike, raw: unknown): void {
    if (this.socket !== socket) return;
    const text = typeof raw === "string" ? raw : raw instanceof ArrayBuffer ? new TextDecoder().decode(raw) : String(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.log("warn", "non-JSON frame ignored");
      return;
    }
    const frame = parseServerFrame(parsed);
    if (!frame) {
      const t = typeof parsed === "object" && parsed !== null ? (parsed as { type?: unknown }).type : undefined;
      this.log("warn", `ignoring unknown or malformed frame ${String(t)}`);
      return;
    }
    switch (frame.type) {
      case "welcome":
        if (this.welcomeTimer !== null) {
          this.timers.clearTimeout(this.welcomeTimer);
          this.welcomeTimer = null;
        }
        this._clientId = frame.client_id;
        this._limits = frame.limits;
        this.startKeepalive();
        this.stableTimer = this.timers.setTimeout(() => {
          this.attempt = 0;
          this.stableTimer = null;
        }, this.stableMs);
        this.setState("ready");
        this.emit("welcome", frame);
        return;
      case "ping":
        try {
          socket.send(JSON.stringify({ type: "pong", t: frame.t }));
        } catch {
          /* closing */
        }
        return;
      case "pong":
        if (this.deadTimer !== null) {
          this.timers.clearTimeout(this.deadTimer);
          this.deadTimer = null;
        }
        return;
      case "error":
        this.log("warn", `relay error ${frame.code}${frame.message ? ": " + frame.message : ""}`);
        this.emit("error", frame);
        return;
      case "opened":
        this.emit("opened", frame);
        return;
      case "closed":
        this.emit("closed", frame);
        return;
      case "data":
        this.emit("data", frame);
        return;
      case "pair_joined":
        this.emit("pair_joined", frame);
        return;
      case "pair_msg":
        this.emit("pair_msg", frame);
        return;
      case "pair_result":
        this.emit("pair_result", frame);
        return;
      case "device_status":
        this.emit("device_status", frame);
        return;
    }
  }

  private startKeepalive(): void {
    const tick = () => {
      this.pingTimer = null;
      const s = this.socket;
      if (!s || s.readyState !== WS_OPEN) return;
      try {
        s.send(JSON.stringify({ type: "ping", t: this.timers.now() }));
      } catch {
        return;
      }
      if (this.deadTimer === null) {
        this.deadTimer = this.timers.setTimeout(() => {
          this.deadTimer = null;
          this.log("warn", "no pong in time; dropping connection");
          this.drop(s, 4000, "pong timeout");
        }, this.pongDeadMs);
      }
      this.pingTimer = this.timers.setTimeout(tick, this.pingIntervalMs);
    };
    this.pingTimer = this.timers.setTimeout(tick, this.pingIntervalMs);
  }

  /** Close a socket we no longer trust and process the close locally right away. */
  private drop(socket: WebSocketLike, code: number, reason: string): void {
    if (this.socket !== socket) return;
    this.detach(socket);
    this.socket = null;
    try {
      socket.close(code, reason);
    } catch {
      /* already closed */
    }
    this.handleClose(code, reason);
  }

  private detach(socket: WebSocketLike): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  private handleClose(code: number, reason: string): void {
    this.clearTimers();
    if (this.socket) {
      this.detach(this.socket);
      this.socket = null;
    }
    this._clientId = null;
    if (this.manualClose) {
      this.setState("closed");
      this.emit("disconnected", { code, reason, willReconnect: false });
      return;
    }
    if (code === CLOSE_CODES.UNAUTHORIZED) {
      this.log("warn", "relay closed 4001: not authorized");
      this.setState("closed");
      this.emit("auth_lost", { code, reason });
      this.emit("disconnected", { code, reason, willReconnect: false });
      return;
    }
    if (code === CLOSE_CODES.PROTOCOL_VIOLATION) {
      this.log("error", `relay closed 4002: protocol violation (${reason})`);
      this.setState("closed");
      this.emit("fatal", { code, reason });
      this.emit("disconnected", { code, reason, willReconnect: false });
      return;
    }
    if (code === CLOSE_CODES.RATE_LIMIT) {
      this.emit("error", { type: "error", code: "E_RATE_LIMIT", message: reason || "rate limited (4003)" });
    } else if (code === CLOSE_CODES.FRAME_TOO_LARGE) {
      this.emit("error", { type: "error", code: "E_TOO_LARGE", message: reason || "frame too large (4004)" });
    }
    this.emit("disconnected", { code, reason, willReconnect: true });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const exp = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.min(this.attempt, 30));
    const delay = Math.floor(this.random() * exp);
    this.attempt += 1;
    this.setState("waiting", delay);
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualClose) return;
      this.dial();
    }, delay);
  }

  private clearTimers(): void {
    for (const key of ["pingTimer", "deadTimer", "stableTimer", "reconnectTimer", "welcomeTimer"] as const) {
      const h = this[key];
      if (h !== null) {
        this.timers.clearTimeout(h);
        this[key] = null;
      }
    }
  }
}
