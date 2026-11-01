// DeviceSession — per-device E2E state machine on top of RelayClient (SPEC §5, §6, §7).
//   open()  : relay `open` → `hello` → verify `hello_ack.mac` → `confirm` → first envelope `device_info`
//   request : one encrypted request → one correlated response (30 s)
//   stream  : `chat` → chat_chunk* → chat_done (idle 120 s → stalled callback or timeout)
// Keys live only in this object (non-extractable CryptoKeys); PK is borrowed from the pairing record.

import { b64urlDecode, b64urlDecodeLen, b64urlEncode } from "../crypto/b64url";
import { equalBytes, utf8, utf8Decode, zeroize } from "../crypto/bytes";
import {
  DIR_C2D,
  DIR_D2C,
  EnvelopeError,
  MAX_COUNTER,
  importAesGcmKey,
  openEnvelope,
  sealEnvelope,
} from "../crypto/envelope";
import { deriveSessionKeys, generateEphemeral, x25519SharedSecret } from "../crypto/session";
import { uuidToRaw } from "../crypto/uuid";
import {
  parseInboundMessage,
  validateOutbound,
  type AbortRequest,
  type AgentDeleteRequest,
  type AgentListRequest,
  type AgentMessage,
  type AgentSaveRequest,
  type AgentsMessage,
  type ChatChunkMessage,
  type ChatDoneMessage,
  type ChatRequest,
  type ConversationMessage,
  type DeleteModelRequest,
  type DeviceInfoMessage,
  type HistoryClearRequest,
  type HistoryDeleteRequest,
  type HistoryGetRequest,
  type HistoryListRequest,
  type HistoryMessage,
  type InboundMessage,
  type ListModelsRequest,
  type ListRunningRequest,
  type ModelInfoMessage,
  type ModelsMessage,
  type OkMessage,
  type SkillDeleteRequest,
  type SkillListRequest,
  type SkillMessage,
  type SkillSaveRequest,
  type SkillsMessage,
  type OutboundRequest,
  type PullDoneMessage,
  type PullModelRequest,
  type PullProgressMessage,
  type RunningMessage,
  type ShowModelRequest,
} from "../protocol/channel";
import { PROTOCOL_VERSION, TIMEOUTS, type HandshakeRejectCode } from "../protocol/constants";
import { Correlator, TimeoutError } from "../protocol/correlator";
import { classifyPayload, type HandshakeInbound, type HsConfirm, type HsHello } from "../protocol/handshake";
import { newRequestId } from "../protocol/ids";
import type { DataFrame, ErrorFrame } from "../protocol/relay";
import { realTimers, type TimerHandle, type Timers } from "../protocol/timers";
import type { PairingRecord } from "../lib/storage";
import { TypedEmitter } from "../relay/events";
import type { RelayClient, RelayLogger } from "../relay/client";

export type SessionStatus =
  | "idle"
  | "opening"
  | "handshaking"
  | "ready"
  | "offline"
  | "needs-pairing"
  | "closed"
  | "error";

export class SessionError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message ?? code);
    this.name = "SessionError";
  }
}

export interface SessionStatusChange {
  status: SessionStatus;
  error?: SessionError;
}

export interface SessionEvents {
  status: SessionStatusChange;
  device_info: DeviceInfoMessage;
  needs_pairing: { code: HandshakeRejectCode | "E_HANDSHAKE_FAILED" };
  /** Non-fatal problems worth surfacing (discarded envelopes, unmatched messages). */
  warning: { code: string; message: string };
}

export interface DeviceSessionOptions {
  deviceId: string;
  pairing: Pick<PairingRecord, "pairing_id" | "pk">;
  timers?: Timers;
  /** Re-open automatically when the device comes back online / the relay reconnects. Default true. */
  autoReopen?: boolean;
  requestTimeoutMs?: number;
  chatIdleMs?: number;
  pullIdleMs?: number;
  handshakeTimeoutMs?: number;
  log?: RelayLogger;
  /** Fresh-`hello` attempts per open() before suggesting a new pairing (SPEC §5.3). */
  maxHandshakeAttempts?: number;
}

export interface StreamHandlers {
  onChunk: (chunk: ChatChunkMessage) => void;
  /** Called every idle period without chunks; when absent the stream rejects on idle. */
  onStalled?: () => void;
}

type ResponseFor<R extends OutboundRequest> = R extends ListModelsRequest
  ? ModelsMessage
  : R extends ListRunningRequest
    ? RunningMessage
    : R extends ShowModelRequest
      ? ModelInfoMessage
      : R extends AbortRequest | DeleteModelRequest | HistoryDeleteRequest | HistoryClearRequest | AgentDeleteRequest | SkillDeleteRequest
        ? OkMessage
        : R extends HistoryListRequest
          ? HistoryMessage
          : R extends HistoryGetRequest
            ? ConversationMessage
            : R extends AgentListRequest
              ? AgentsMessage
              : R extends AgentSaveRequest
                ? AgentMessage
                : R extends SkillListRequest
                  ? SkillsMessage
                  : R extends SkillSaveRequest
                    ? SkillMessage
                    : never;

type UnaryRequest = Exclude<OutboundRequest, ChatRequest | PullModelRequest>;

const EXPECTED_RESPONSE: Record<UnaryRequest["type"], InboundMessage["type"]> = {
  list_models: "models",
  list_running: "running",
  show_model: "model_info",
  abort: "ok",
  delete_model: "ok",
  history_list: "history",
  history_get: "conversation",
  history_delete: "ok",
  history_clear: "ok",
  agent_list: "agents",
  agent_save: "agent",
  agent_delete: "ok",
  skill_list: "skills",
  skill_save: "skill",
  skill_delete: "ok",
};

interface Waiter<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  cancel: () => void;
}

/** Serializes async work so envelope counters go out (and are consumed) strictly in order. */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

const silentLog: RelayLogger = () => undefined;

export class DeviceSession extends TypedEmitter<SessionEvents> {
  readonly deviceId: string;
  private readonly deviceIdRaw: Uint8Array;
  private readonly pairingId: Uint8Array;
  private readonly pk: Uint8Array;
  private readonly timers: Timers;
  private readonly autoReopen: boolean;
  private readonly requestTimeoutMs: number;
  private readonly chatIdleMs: number;
  private readonly pullIdleMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly maxHandshakeAttempts: number;
  private readonly log: RelayLogger;
  private readonly correlator: Correlator<InboundMessage>;
  private readonly inbound = new SerialQueue();
  private readonly outbound = new SerialQueue();
  private readonly offs: (() => void)[] = [];

  private _status: SessionStatus = "idle";
  private _deviceInfo: DeviceInfoMessage | null = null;
  private _lastError: SessionError | null = null;
  private keys: { send: CryptoKey; recv: CryptoKey } | null = null;
  private sendCounter = 0;
  private recvCounter = 0;
  private wantOpen = false;
  private openPromise: Promise<DeviceInfoMessage> | null = null;
  private pendingOpened: Waiter<void> | null = null;
  private pendingAck: Waiter<HandshakeInbound> | null = null;
  private pendingInfo: Waiter<DeviceInfoMessage> | null = null;
  private deviceOnline: boolean | null = null;
  /** Stream ids whose terminal frame (chat_done/pull_done) is still expected after an error/abort. */
  private readonly trailing = new Map<string, TimerHandle>();
  private reopenTimer: TimerHandle | null = null;
  private reopenAttempts = 0;
  private disposed = false;

  constructor(
    private readonly relay: RelayClient,
    opts: DeviceSessionOptions,
  ) {
    super();
    this.deviceId = opts.deviceId;
    this.deviceIdRaw = uuidToRaw(opts.deviceId);
    this.pairingId = opts.pairing.pairing_id;
    this.pk = opts.pairing.pk;
    this.timers = opts.timers ?? realTimers;
    this.autoReopen = opts.autoReopen ?? true;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? TIMEOUTS.REQUEST_MS;
    this.chatIdleMs = opts.chatIdleMs ?? TIMEOUTS.CHAT_IDLE_MS;
    this.pullIdleMs = opts.pullIdleMs ?? TIMEOUTS.PULL_IDLE_MS;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? TIMEOUTS.HANDSHAKE_MS;
    this.maxHandshakeAttempts = opts.maxHandshakeAttempts ?? TIMEOUTS.HANDSHAKE_ATTEMPTS;
    this.log = opts.log ?? silentLog;
    this.correlator = new Correlator<InboundMessage>(this.timers);
    this.subscribe();
  }

  get status(): SessionStatus {
    return this._status;
  }
  get deviceInfo(): DeviceInfoMessage | null {
    return this._deviceInfo;
  }
  get lastError(): SessionError | null {
    return this._lastError;
  }
  get isReady(): boolean {
    return this._status === "ready" && this.keys !== null;
  }
  /** Last known presence from the relay (`null` until a device_status/welcome is seen). */
  get online(): boolean | null {
    return this.deviceOnline;
  }

  // ── public API ───────────────────────────────────────────────────────────

  /** Open the relay session and run the E2E handshake. Idempotent while in flight. */
  open(): Promise<DeviceInfoMessage> {
    if (this.disposed) return Promise.reject(new SessionError("E_CLOSED", "session disposed"));
    this.wantOpen = true;
    if (this.isReady && this._deviceInfo) return Promise.resolve(this._deviceInfo);
    if (this.openPromise) return this.openPromise;
    const p = this.doOpen().finally(() => {
      if (this.openPromise === p) this.openPromise = null;
    });
    this.openPromise = p;
    return p;
  }

  /**
   * Send `msg` while `pending` (already registered in the correlator) is waiting. If the session
   * dies meanwhile, the correlator's rejection (e.g. E_DEVICE_OFFLINE) is the error that matters.
   */
  private async sendTracked(msg: OutboundRequest, pending: Promise<InboundMessage>): Promise<void> {
    let pendingError: SessionError | null = null;
    pending.catch((e: unknown) => {
      pendingError = toSessionError(e);
    });
    try {
      await this.sendEncrypted(msg);
    } catch (e) {
      await Promise.resolve();
      const err: SessionError = pendingError ?? toSessionError(e);
      this.correlator.cancel(msg.id, err);
      throw err;
    }
  }

  /** One request → one response. Throws `SessionError` for `error` replies and timeouts. */
  async request<R extends UnaryRequest>(msg: R): Promise<ResponseFor<R>> {
    this.ensureReady();
    validateOutbound(msg);
    const pending = this.correlator.request(msg.id, this.requestTimeoutMs);
    await this.sendTracked(msg, pending);
    const res = await pending.catch((e: unknown) => {
      throw toSessionError(e);
    });
    if (res.type === "error") throw new SessionError(res.code, res.message, res.retry_after_ms);
    if (res.type !== EXPECTED_RESPONSE[msg.type]) {
      throw new SessionError("E_PROTOCOL", `unexpected response ${res.type} to ${msg.type}`);
    }
    return res as ResponseFor<R>;
  }

  /** `chat` stream. Resolves with `chat_done` (including `done_reason: "abort"`). */
  async stream(msg: ChatRequest, handlers: StreamHandlers): Promise<ChatDoneMessage> {
    this.ensureReady();
    validateOutbound(msg);
    const streamOpts = {
      idleMs: this.chatIdleMs,
      onEvent: (m: InboundMessage) => {
        if (m.type === "chat_chunk") handlers.onChunk(m);
        else this.warn("E_PROTOCOL", `unexpected ${m.type} inside chat stream ${msg.id}`);
      },
      isDone: (m: InboundMessage) => m.type === "chat_done",
      ...(handlers.onStalled ? { onIdle: handlers.onStalled } : {}),
    };
    const pending = this.correlator.stream(msg.id, streamOpts);
    await this.sendTracked(msg, pending);
    let res: InboundMessage;
    try {
      res = await pending;
    } catch (e) {
      const err = toSessionError(e);
      if (err.code === "E_TIMEOUT" && this.isReady) {
        // Nothing arrived for a whole idle period and the caller did not opt into "stalled":
        // tell the tray to stop so the next chat is not rejected with E_BUSY. The resulting
        // chat_done{abort} is then expected and ignored.
        this.expectTrailing(msg.id);
        void this.abort(msg.id).catch(() => undefined);
      }
      throw err;
    }
    if (res.type === "error") {
      // Failures after acceptance (E_MODEL_NOT_FOUND, E_OLLAMA_DOWN, E_OLLAMA_ERROR) are followed
      // by chat_done{done_reason:"error"}; pre-acceptance ones are not. Either way: ignore it.
      this.expectTrailing(msg.id);
      throw new SessionError(res.code, res.message, res.retry_after_ms);
    }
    if (res.type !== "chat_done") throw new SessionError("E_PROTOCOL", `unexpected ${res.type} ending chat`);
    return res;
  }

  /** `pull_model` stream. Resolves with `pull_done`. */
  async pull(msg: PullModelRequest, onProgress: (p: PullProgressMessage) => void): Promise<PullDoneMessage> {
    this.ensureReady();
    validateOutbound(msg);
    const pending = this.correlator.stream(msg.id, {
      idleMs: this.pullIdleMs,
      onEvent: (m) => {
        if (m.type === "pull_progress") onProgress(m);
        else this.warn("E_PROTOCOL", `unexpected ${m.type} inside pull stream ${msg.id}`);
      },
      isDone: (m) => m.type === "pull_done",
    });
    await this.sendTracked(msg, pending);
    const res = await pending.catch((e: unknown) => {
      throw toSessionError(e);
    });
    if (res.type === "error") {
      this.expectTrailing(msg.id);
      throw new SessionError(res.code, res.message, res.retry_after_ms);
    }
    if (res.type !== "pull_done") throw new SessionError("E_PROTOCOL", `unexpected ${res.type} ending pull`);
    return res;
  }

  /** Abort an in-flight chat by its request id. */
  abort(targetId: string): Promise<OkMessage> {
    return this.request({ type: "abort", id: newRequestId(), target_id: targetId });
  }

  /** Close the relay session and stop auto-reopen. The object stays usable for `open()`. */
  close(): void {
    this.wantOpen = false;
    this.clearReopen();
    const active = this._status === "opening" || this._status === "handshaking" || this._status === "ready";
    this.resetCrypto();
    this.failPending(new SessionError("E_CLOSED", "session closed"));
    if (active && this.relay.isReady) {
      try {
        this.relay.closeSession(this.deviceId);
      } catch {
        /* relay went away */
      }
    }
    this.setStatus("closed");
  }

  /** Close and detach from the relay for good. */
  dispose(): void {
    if (this.disposed) return;
    this.close();
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.removeAllListeners();
  }

  // ── handshake ────────────────────────────────────────────────────────────

  private async doOpen(): Promise<DeviceInfoMessage> {
    this.clearReopen();
    this.resetCrypto();
    try {
      this.setStatus("opening");
      await this.relay.whenReady(this.handshakeTimeoutMs);
      if (this.deviceOnline === false) throw new SessionError("E_DEVICE_OFFLINE", "device is offline");

      const opened = this.waiter<void>(this.handshakeTimeoutMs, "opened");
      this.pendingOpened = opened;
      try {
        this.relay.openSession(this.deviceId);
        await opened.promise;
      } finally {
        this.pendingOpened = null;
      }

      this.setStatus("handshaking");
      // The device drops a bad/malformed handshake silently (no `reject`): on timeout or a bad
      // mac_d, retry with a fresh ephemeral key, then suggest re-pairing (SPEC §5.3).
      let last: SessionError | null = null;
      for (let attempt = 1; attempt <= this.maxHandshakeAttempts; attempt++) {
        try {
          const info = await this.handshakeOnce();
          this.reopenAttempts = 0;
          this._lastError = null;
          this.setStatus("ready");
          return info;
        } catch (e) {
          const err = toSessionError(e);
          this.resetCrypto();
          const retryable = err.code === "E_TIMEOUT" || err.code === "E_HANDSHAKE_MAC";
          if (!retryable || this._status !== "handshaking") throw err;
          last = err;
          this.log("warn", `[session ${this.deviceId}] handshake attempt ${attempt}/${this.maxHandshakeAttempts} failed (${err.code})`);
        }
      }
      throw new SessionError(
        "E_HANDSHAKE_FAILED",
        `device did not complete the handshake after ${this.maxHandshakeAttempts} attempts (${last?.code ?? "?"}): pair again, or check that the device is reachable`,
      );
    } catch (e) {
      const err = toSessionError(e);
      this.resetCrypto();
      this.handleOpenFailure(err);
      throw err;
    }
  }

  /** One hello → hello_ack (verify mac_d) → confirm → device_info exchange. */
  private async handshakeOnce(): Promise<DeviceInfoMessage> {
    const eph = generateEphemeral();
    const ackWaiter = this.waiter<HandshakeInbound>(this.handshakeTimeoutMs, "hello_ack");
    this.pendingAck = ackWaiter;
    let ack: HandshakeInbound;
    try {
      const hello: HsHello = {
        hs: "hello",
        v: PROTOCOL_VERSION,
        pairing_id: b64urlEncode(this.pairingId),
        eph_pub: b64urlEncode(eph.pub),
      };
      this.relay.sendData(this.deviceId, { ...hello });
      ack = await ackWaiter.promise;
    } catch (e) {
      zeroize(eph.priv);
      throw e;
    } finally {
      this.pendingAck = null;
    }
    if (ack.hs === "reject") {
      zeroize(eph.priv);
      throw new SessionError(ack.code, `device rejected the handshake (${ack.code})`);
    }
    let pubD: Uint8Array;
    let macD: Uint8Array;
    try {
      pubD = b64urlDecodeLen(ack.eph_pub, 32);
      macD = b64urlDecodeLen(ack.mac, 32);
    } catch {
      zeroize(eph.priv);
      throw new SessionError("E_HANDSHAKE_MAC", "malformed hello_ack");
    }
    let ss: Uint8Array;
    try {
      ss = x25519SharedSecret(eph.priv, pubD);
    } catch {
      zeroize(eph.priv);
      throw new SessionError("E_HANDSHAKE_MAC", "invalid device ephemeral key");
    }
    zeroize(eph.priv);
    const keys = deriveSessionKeys(this.pk, this.pairingId, eph.pub, pubD, ss);
    zeroize(ss);
    const macOk = equalBytes(keys.mac_d, macD);
    if (!macOk) {
      zeroize(keys.k_c2d);
      zeroize(keys.k_d2c);
      zeroize(keys.k_conf_c);
      zeroize(keys.k_conf_d);
      throw new SessionError("E_HANDSHAKE_MAC", "device MAC does not verify");
    }
    const send = await importAesGcmKey(keys.k_c2d);
    const recv = await importAesGcmKey(keys.k_d2c);
    zeroize(keys.k_c2d);
    zeroize(keys.k_d2c);
    zeroize(keys.k_conf_c);
    zeroize(keys.k_conf_d);
    this.keys = { send, recv };
    this.sendCounter = 0;
    this.recvCounter = 0;

    // A bad mac_c is dropped silently by the device: only device_info proves acceptance.
    const infoWaiter = this.waiter<DeviceInfoMessage>(this.handshakeTimeoutMs, "device_info");
    this.pendingInfo = infoWaiter;
    try {
      const confirm: HsConfirm = { hs: "confirm", v: PROTOCOL_VERSION, mac: b64urlEncode(keys.mac_c) };
      this.relay.sendData(this.deviceId, { ...confirm });
      return await infoWaiter.promise;
    } finally {
      this.pendingInfo = null;
      zeroize(keys.mac_c);
    }
  }

  private handleOpenFailure(err: SessionError): void {
    this._lastError = err;
    if (this._status === "closed") return;
    if (err.code === "E_UNKNOWN_PAIRING" || err.code === "E_HANDSHAKE_FAILED") {
      this.wantOpen = false;
      this.setStatus("needs-pairing", err);
      this.emit("needs_pairing", { code: err.code });
      return;
    }
    if (err.code === "E_VERSION") {
      this.wantOpen = false;
      this.setStatus("error", err);
      return;
    }
    if (err.code === "E_DEVICE_OFFLINE" || err.code === "E_NOT_FOUND") {
      if (err.code === "E_DEVICE_OFFLINE") this.deviceOnline = false;
      this.setStatus("offline", err);
      return;
    }
    if (err.code === "E_CLOSED") {
      this.setStatus(this.relay.isReady ? "error" : "offline", err);
      return;
    }
    if (err.code === "E_NO_SESSION") {
      // Torn down by the device/relay while opening: re-handshake on next use.
      this.setStatus(this.deviceOnline === false ? "offline" : "idle", err);
      return;
    }
    this.setStatus("error", err);
    if (this.wantOpen && this.autoReopen) this.scheduleReopen();
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  private subscribe(): void {
    const r = this.relay;
    this.offs.push(
      r.on("data", (f) => this.onData(f)),
      r.on("opened", (f) => {
        if (f.device_id === this.deviceId) this.pendingOpened?.resolve();
      }),
      r.on("closed", (f) => {
        if (f.device_id !== this.deviceId) return;
        // Closed by the device (`reason:"device"`), by us, or by the relay: tear down; the next
        // open() — or `device_status online` (SPEC §3.7) — runs a fresh handshake.
        this.onSessionLost(
          new SessionError("E_NO_SESSION", `session closed (${f.reason || "relay"})`),
          this.deviceOnline === false ? "offline" : "idle",
        );
      }),
      r.on("device_status", (f) => {
        if (f.device_id !== this.deviceId) return;
        this.deviceOnline = f.online;
        if (!f.online) {
          this.onSessionLost(new SessionError("E_DEVICE_OFFLINE", "device went offline"), "offline");
          return;
        }
        if (this.wantOpen && this.autoReopen && !this.openPromise && this._status !== "ready") {
          this.reopenAttempts = 0;
          this.scheduleReopen(0);
        }
      }),
      r.on("welcome", (w) => {
        const d = w.devices.find((x) => x.device_id === this.deviceId);
        if (d) this.deviceOnline = d.online;
        if (this.wantOpen && this.autoReopen && !this.openPromise && this._status !== "ready" && this.deviceOnline !== false) {
          this.reopenAttempts = 0;
          this.scheduleReopen(0);
        }
      }),
      r.on("error", (f) => this.onRelayError(f)),
      r.on("state", (s) => {
        if (s.state === "ready") return;
        // connecting / waiting / closed: the relay connection is gone, so is the session.
        this.onSessionLost(new SessionError("E_NO_SESSION", `relay ${s.state}`), s.state === "closed" ? "error" : "offline");
      }),
      r.on("auth_lost", () => {
        this.wantOpen = false;
      }),
    );
  }

  private onRelayError(f: ErrorFrame): void {
    if (f.ref !== undefined && f.ref !== this.deviceId) return;
    const err = new SessionError(f.code, f.message ?? f.code, f.retry_after_ms);
    if (this.pendingOpened) {
      if (["E_DEVICE_OFFLINE", "E_NOT_FOUND", "E_LIMIT", "E_RATE_LIMIT", "E_INVALID", "E_NO_SESSION"].includes(f.code)) {
        this.pendingOpened.reject(err);
      }
      return;
    }
    if (f.code === "E_NO_SESSION" && (this._status === "ready" || this._status === "handshaking")) {
      this.onSessionLost(err, this.deviceOnline === false ? "offline" : "idle");
    }
  }

  private onData(frame: DataFrame): void {
    if (frame.device_id !== this.deviceId) return;
    const c = classifyPayload(frame.payload);
    if (c.kind === "invalid") {
      this.warn("E_INVALID", `discarding payload: ${c.reason}`);
      return;
    }
    if (c.kind === "handshake") {
      if (this.pendingAck) {
        this.pendingAck.resolve(c.msg);
        return;
      }
      if (c.msg.hs === "reject" && this._status === "ready") {
        const err = new SessionError(c.msg.code, `device rejected the session (${c.msg.code})`);
        this.onSessionLost(err, c.msg.code === "E_UNKNOWN_PAIRING" ? "needs-pairing" : "error");
        if (c.msg.code === "E_UNKNOWN_PAIRING") {
          this.wantOpen = false;
          this.emit("needs_pairing", { code: "E_UNKNOWN_PAIRING" });
        }
        return;
      }
      this.warn("E_PROTOCOL", `unexpected handshake message ${c.msg.hs} in status ${this._status}`);
      return;
    }
    const env = c.env;
    void this.inbound.run(async () => {
      const keys = this.keys;
      if (!keys) {
        this.warn("E_NO_SESSION", "envelope before session keys; discarded");
        return;
      }
      if (env.v !== PROTOCOL_VERSION) {
        this.warn("E_VERSION", `envelope v=${env.v} discarded`);
        return;
      }
      if (env.device_id !== this.deviceId) {
        this.warn("E_INVALID", "envelope for another device discarded");
        return;
      }
      let nonce: Uint8Array;
      let ciphertext: Uint8Array;
      try {
        nonce = b64urlDecodeLen(env.nonce, 12);
        ciphertext = b64urlDecode(env.ciphertext);
      } catch {
        this.warn("E_INVALID", "envelope with malformed base64url discarded");
        return;
      }
      let plaintext: Uint8Array;
      try {
        plaintext = await openEnvelope(keys.recv, DIR_D2C, this.recvCounter, this.deviceIdRaw, nonce, ciphertext);
      } catch (e) {
        if (e instanceof EnvelopeError && e.code === "E_COUNTER") {
          // Replay or loss: close the session and force a new handshake (SPEC §6.3).
          this.log("warn", `[session ${this.deviceId}] envelope counter mismatch; closing session`);
          const err = new SessionError("E_COUNTER", "envelope counter out of order");
          const wanted = this.wantOpen;
          this.onSessionLost(err, "error");
          if (this.relay.isReady) {
            try {
              this.relay.closeSession(this.deviceId);
            } catch {
              /* ignore */
            }
          }
          if (wanted && this.autoReopen) this.scheduleReopen();
          return;
        }
        // Bad tag / wrong AAD: discard silently and log (SPEC §6.3). Never respond.
        this.log("warn", `[session ${this.deviceId}] envelope failed to authenticate; discarded`);
        return;
      }
      if (this.recvCounter >= MAX_COUNTER) {
        this.onSessionLost(new SessionError("E_COUNTER", "receive counter exhausted"), "error");
        return;
      }
      this.recvCounter += 1;
      let json: unknown;
      try {
        json = JSON.parse(utf8Decode(plaintext));
      } catch {
        this.warn("E_INVALID", "decrypted message is not JSON");
        return;
      }
      const parsed = parseInboundMessage(json);
      if (!parsed.ok) {
        if (parsed.reason === "unknown_type") console.warn(`[session] ignoring unknown message type "${parsed.type}"`);
        else this.warn("E_INVALID", `malformed ${parsed.type} message discarded`);
        return;
      }
      this.handleMessage(parsed.message);
    });
  }

  private handleMessage(m: InboundMessage): void {
    if (m.type === "device_info") {
      // First envelope after confirm, and re-sent unsolicited whenever the Ollama status changes.
      this._deviceInfo = m;
      if (this.pendingInfo) this.pendingInfo.resolve(m);
      this.emit("device_info", m);
      return;
    }
    if ((m.type === "chat_done" || m.type === "pull_done") && this.trailing.has(m.id)) {
      this.timers.clearTimeout(this.trailing.get(m.id));
      this.trailing.delete(m.id);
      this.log("debug", `[session ${this.deviceId}] ignoring trailing ${m.type} for ${m.id}`);
      return;
    }
    if (this.correlator.dispatch(m)) return;
    if (m.type === "error") {
      this.warn(m.code, m.message ?? `device error ${m.code}`);
      return;
    }
    this.warn("E_UNMATCHED", `no pending request for ${m.type}${m.id ? " id=" + m.id : ""}`);
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  private sendEncrypted(msg: OutboundRequest): Promise<void> {
    return this.outbound.run(async () => {
      const keys = this.keys;
      if (!keys || this._status !== "ready") throw new SessionError("E_NO_SESSION", "session is not ready");
      if (this.sendCounter >= MAX_COUNTER) {
        this.onSessionLost(new SessionError("E_COUNTER", "send counter exhausted"), "error");
        throw new SessionError("E_COUNTER", "send counter exhausted");
      }
      const counter = this.sendCounter;
      this.sendCounter += 1;
      const { nonce, ciphertext } = await sealEnvelope(keys.send, DIR_C2D, counter, this.deviceIdRaw, utf8(JSON.stringify(msg)));
      this.relay.sendData(this.deviceId, {
        v: PROTOCOL_VERSION,
        device_id: this.deviceId,
        nonce: b64urlEncode(nonce),
        ciphertext: b64urlEncode(ciphertext),
      });
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private ensureReady(): void {
    if (this.disposed) throw new SessionError("E_CLOSED", "session disposed");
    if (!this.isReady) throw new SessionError("E_NO_SESSION", `session is ${this._status}`);
  }

  private waiter<T>(timeoutMs: number, what: string): Waiter<T> {
    let resolve!: (v: T) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = this.timers.setTimeout(() => reject(new SessionError("E_TIMEOUT", `timed out waiting for ${what}`)), timeoutMs);
    const cancel = () => this.timers.clearTimeout(timer);
    promise.then(cancel, cancel);
    return { promise, resolve, reject, cancel };
  }

  private failPending(err: SessionError): void {
    this.pendingOpened?.reject(err);
    this.pendingAck?.reject(err);
    this.pendingInfo?.reject(err);
    this.correlator.rejectAll(err);
  }

  private resetCrypto(): void {
    this.keys = null;
    this.sendCounter = 0;
    this.recvCounter = 0;
    for (const h of this.trailing.values()) this.timers.clearTimeout(h);
    this.trailing.clear();
  }

  /** Remember that `id` will still produce a terminal frame we must swallow (bounded by a TTL). */
  private expectTrailing(id: string): void {
    const prev = this.trailing.get(id);
    if (prev !== undefined) this.timers.clearTimeout(prev);
    this.trailing.set(
      id,
      this.timers.setTimeout(() => this.trailing.delete(id), 60_000),
    );
  }

  private onSessionLost(err: SessionError, status: SessionStatus): void {
    const wasActive = this._status === "opening" || this._status === "handshaking" || this._status === "ready";
    this.resetCrypto();
    this.failPending(err);
    if (wasActive || this._status === "idle" || status === "needs-pairing") {
      this._lastError = err;
      this.setStatus(status, err);
    }
  }

  private scheduleReopen(delayMs?: number): void {
    if (this.disposed || !this.wantOpen || this.reopenTimer !== null || this.openPromise) return;
    if (this.reopenAttempts >= 5 && delayMs === undefined) {
      this.log("warn", `[session ${this.deviceId}] giving up automatic reopen`);
      return;
    }
    const delay = delayMs ?? Math.min(30_000, 1_000 * 2 ** this.reopenAttempts);
    this.reopenAttempts += 1;
    this.reopenTimer = this.timers.setTimeout(() => {
      this.reopenTimer = null;
      if (!this.wantOpen || this.disposed) return;
      void this.open().catch(() => undefined);
    }, delay);
  }

  private clearReopen(): void {
    if (this.reopenTimer !== null) {
      this.timers.clearTimeout(this.reopenTimer);
      this.reopenTimer = null;
    }
  }

  private setStatus(status: SessionStatus, error?: SessionError): void {
    if (status !== "ready") this._deviceInfo = status === "closed" || status === "needs-pairing" ? null : this._deviceInfo;
    this._status = status;
    const change: SessionStatusChange = { status };
    if (error) change.error = error;
    this.emit("status", change);
  }

  private warn(code: string, message: string): void {
    this.log("warn", `[session ${this.deviceId}] ${message}`);
    this.emit("warning", { code, message });
  }
}

export function toSessionError(e: unknown): SessionError {
  if (e instanceof SessionError) return e;
  if (e instanceof TimeoutError) return new SessionError("E_TIMEOUT", e.message);
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return new SessionError(typeof code === "string" ? code : "E_INTERNAL", e.message);
  }
  return new SessionError("E_INTERNAL", String(e));
}
