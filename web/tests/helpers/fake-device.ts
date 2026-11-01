// A relay + tray double driven through a FakeWebSocket, using the SAME crypto modules as the app.
// Implements side B of SPAKE2, side D of the session handshake, and a few application replies.

import { p256 } from "@noble/curves/nist.js";
import { b64urlDecode, b64urlEncode } from "../../src/crypto/b64url";
import { equalBytes, utf8, utf8Decode } from "../../src/crypto/bytes";
import { pairingCodeToW } from "../../src/crypto/code";
import { DIR_C2D, DIR_D2C, importAesGcmKey, openEnvelope, sealEnvelope } from "../../src/crypto/envelope";
import { pairingIdFromPK, pairingKeyFromKe } from "../../src/crypto/pairing";
import { deriveSessionKeys, generateEphemeral, x25519SharedSecret } from "../../src/crypto/session";
import {
  SPAKE2_M,
  SPAKE2_N,
  TUNNELIO_SPAKE2,
  decodePoint,
  encodePoint,
  randomScalar,
  scalarMul,
  spake2Transcript,
  type Spake2Identities,
} from "../../src/crypto/spake2";
import { uuidToRaw } from "../../src/crypto/uuid";
import type { Agent, DeviceInfoMessage, InboundMessage, OutboundRequest, Skill, RunningModel } from "../../src/protocol/channel";
import type { JsonObject } from "../../src/protocol/validate";
import { FakeWebSocket } from "./fake-ws";

export function spake2B(ids: Spake2Identities, w: bigint, y: bigint, pABytes: Uint8Array) {
  const pA = decodePoint(pABytes);
  const pB = scalarMul(SPAKE2_N, w).add(p256.Point.BASE.multiply(y));
  const pBBytes = encodePoint(pB);
  const K = encodePoint(pA.subtract(scalarMul(SPAKE2_M, w)).multiply(y));
  const t = spake2Transcript(ids, pABytes, pBBytes, K, w);
  return { pB: pBBytes, cB: t.cB, cA: t.cA, Ke: t.Ke, K };
}

export const DEVICE_ID = "0192f6a0-5e7b-7c3d-9a4e-1b2c3d4e5f60";

export const DEVICE_INFO: DeviceInfoMessage = {
  type: "device_info",
  protocol_versions: [1],
  tray_version: "0.1.0-test",
  platform: "linux",
  ollama: { status: "running", version: "0.12.0" },
  limits: { max_message_bytes: 8_388_608, chat_concurrency: 1, pull_concurrency: 1, max_images_per_message: 4, max_image_bytes: 4_194_304 },
  capabilities: ["history", "think", "images", "history_clear", "agents"],
};

/** A tiny valid-looking JPEG header, base64 (standard, padded) — what `images[]` carries. */
export const TINY_JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString("base64");

export interface FakeDeviceOptions {
  deviceId?: string;
  /** Pairings the device knows: pairing_id (b64url) → PK. */
  pairings?: Map<string, Uint8Array>;
  /** Override application handling. Return null to stay silent. */
  handle?: (req: OutboundRequest, reply: (m: InboundMessage) => Promise<void>) => Promise<boolean>;
  /** Corrupt mac_d (tests the browser's verification). */
  badMac?: boolean;
  /** Send `reject` with this code instead of hello_ack. */
  rejectCode?: "E_UNKNOWN_PAIRING" | "E_VERSION" | "E_BUSY";
  /** Drop `hello` silently (as the tray does for a malformed hello). */
  silentHello?: boolean;
  /** Drop `confirm` silently (as the tray does for a bad mac_c), i.e. never send device_info. */
  silentConfirm?: boolean;
  /** Override parts of device_info (e.g. an older tray without "history_clear"). */
  deviceInfo?: Partial<DeviceInfoMessage>;
  /** rev. 1.4 totals in `history` responses; `null` = an older tray that does not send them. Shared, mutable. */
  history?: FakeHistoryState | null;
  /** rev. 1.8 agents and skills the fake tray keeps. Shared, mutable. */
  library?: FakeLibrary;
}

/** What the fake tray keeps of agents and skills (by id). */
export interface FakeLibrary {
  agents: Map<string, Agent>;
  skills: Map<string, Skill>;
}

export function fakeLibrary(): FakeLibrary {
  return { agents: new Map(), skills: new Map() };
}

/** What the fake tray keeps: the canned list ("c1") until `history_clear` empties it. */
export interface FakeHistoryState {
  conversations: number;
  bytes: number;
  cleared: boolean;
}

/** The tray's side of one E2E session (one per client session). */
export class FakeDevice {
  readonly deviceId: string;
  readonly raw: Uint8Array;
  pairings: Map<string, Uint8Array>;
  keys: { send: CryptoKey; recv: CryptoKey } | null = null;
  sendCounter = 0;
  recvCounter = 0;
  received: OutboundRequest[] = [];
  /** What list_running answers (the models Ollama has loaded, with their context). */
  running: RunningModel[] = [];
  hellos = 0;
  readonly library: FakeLibrary;
  private pendingMacC: Uint8Array | null = null;
  private pendingKeys: { k_c2d: Uint8Array; k_d2c: Uint8Array } | null = null;

  constructor(
    private readonly send: (payload: JsonObject) => void,
    private readonly opts: FakeDeviceOptions = {},
  ) {
    this.deviceId = opts.deviceId ?? DEVICE_ID;
    this.raw = uuidToRaw(this.deviceId);
    this.pairings = opts.pairings ?? new Map();
    this.library = opts.library ?? fakeLibrary();
  }

  addPairing(pk: Uint8Array): Uint8Array {
    const pid = pairingIdFromPK(pk);
    this.pairings.set(b64urlEncode(pid), pk);
    return pid;
  }

  async onPayload(payload: JsonObject): Promise<void> {
    if (payload.hs === "hello") {
      this.hellos += 1;
      if (this.opts.silentHello) return;
      const pid = String(payload.pairing_id);
      const pk = this.pairings.get(pid);
      if (!pk || this.opts.rejectCode) {
        this.send({ hs: "reject", v: 1, code: this.opts.rejectCode ?? "E_UNKNOWN_PAIRING" });
        return;
      }
      const pubC = b64urlDecode(String(payload.eph_pub));
      const eph = generateEphemeral();
      const ss = x25519SharedSecret(eph.priv, pubC);
      const keys = deriveSessionKeys(pk, b64urlDecode(pid), pubC, eph.pub, ss);
      this.pendingMacC = keys.mac_c;
      this.pendingKeys = { k_c2d: keys.k_c2d, k_d2c: keys.k_d2c };
      const mac = new Uint8Array(keys.mac_d);
      if (this.opts.badMac) mac[0] = (mac[0] as number) ^ 1;
      this.send({ hs: "hello_ack", v: 1, eph_pub: b64urlEncode(eph.pub), mac: b64urlEncode(mac) });
      return;
    }
    if (payload.hs === "confirm") {
      if (this.opts.silentConfirm) return;
      if (!this.pendingMacC || !this.pendingKeys) return;
      const mac = b64urlDecode(String(payload.mac));
      if (!equalBytes(mac, this.pendingMacC)) {
        this.pendingMacC = null;
        this.pendingKeys = null;
        return; // discard silently
      }
      this.keys = {
        send: await importAesGcmKey(this.pendingKeys.k_d2c),
        recv: await importAesGcmKey(this.pendingKeys.k_c2d),
      };
      this.sendCounter = 0;
      this.recvCounter = 0;
      this.pendingMacC = null;
      this.pendingKeys = null;
      await this.reply({ ...DEVICE_INFO, ...(this.opts.deviceInfo ?? {}) });
      return;
    }
    if (typeof payload.ciphertext === "string") {
      if (!this.keys) return;
      const pt = await openEnvelope(
        this.keys.recv,
        DIR_C2D,
        this.recvCounter,
        this.raw,
        b64urlDecode(String(payload.nonce)),
        b64urlDecode(payload.ciphertext),
      );
      this.recvCounter += 1;
      const req = JSON.parse(utf8Decode(pt)) as OutboundRequest;
      this.received.push(req);
      await this.handle(req);
    }
  }

  async reply(m: InboundMessage): Promise<void> {
    if (!this.keys) throw new Error("fake device has no keys");
    const counter = this.sendCounter++;
    const { nonce, ciphertext } = await sealEnvelope(this.keys.send, DIR_D2C, counter, this.raw, utf8(JSON.stringify(m)));
    this.send({ v: 1, device_id: this.deviceId, nonce: b64urlEncode(nonce), ciphertext: b64urlEncode(ciphertext) });
  }

  /** Send an envelope with an arbitrary counter (for replay tests). */
  async replyWithCounter(m: InboundMessage, counter: number): Promise<void> {
    if (!this.keys) throw new Error("fake device has no keys");
    const { nonce, ciphertext } = await sealEnvelope(this.keys.send, DIR_D2C, counter, this.raw, utf8(JSON.stringify(m)));
    this.send({ v: 1, device_id: this.deviceId, nonce: b64urlEncode(nonce), ciphertext: b64urlEncode(ciphertext) });
  }

  private async handle(req: OutboundRequest): Promise<void> {
    if (this.opts.handle && (await this.opts.handle(req, (m) => this.reply(m)))) return;
    switch (req.type) {
      case "list_models":
        await this.reply({
          type: "models",
          id: req.id,
          models: [
            {
              name: "llama3.2:3b",
              size: 2_019_393_189,
              modified_at: "2026-10-01T00:00:00Z",
              digest: "sha256:abc",
              details: { family: "llama", parameter_size: "3.2B", quantization_level: "Q4_K_M", format: "gguf" },
            },
          ],
        });
        return;
      case "list_running":
        await this.reply({ type: "running", id: req.id, models: this.running });
        return;
      case "show_model":
        await this.reply({
          type: "model_info",
          id: req.id,
          name: req.name,
          details: { family: "llama" },
          context_length: 8192,
          capabilities: req.name.startsWith("llava") || req.name.startsWith("moondream") ? ["completion", "vision"] : ["completion"],
        });
        return;
      case "chat": {
        const last = req.messages[req.messages.length - 1]?.content ?? "";
        for (const word of ["Hello", " ", "world"]) {
          await this.reply({ type: "chat_chunk", id: req.id, content: word });
        }
        await this.reply({
          type: "chat_done",
          id: req.id,
          conversation_id: req.conversation_id,
          done_reason: "stop",
          stats: { eval_count: 3, total_duration: 1_000_000, prompt_eval_count: last.length },
          ...(req.mode === "private" ? { message_id: "m-" + req.id } : {}),
        });
        return;
      }
      case "abort":
      case "delete_model":
      case "history_delete":
        await this.reply({ type: "ok", id: req.id });
        return;
      case "pull_model":
        await this.reply({ type: "pull_progress", id: req.id, name: req.name, status: "pulling", total: 100, completed: 50 });
        await this.reply({ type: "pull_done", id: req.id, name: req.name });
        return;
      case "history_list": {
        const h = this.opts.history === undefined ? { conversations: 1, bytes: 4096, cleared: false } : this.opts.history;
        const all = h?.cleared
          ? []
          : [{ id: "c1", title: "First", model: "llama3.2:3b", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:01:00Z", message_count: 2 }];
        await this.reply({
          type: "history",
          id: req.id,
          conversations: all.slice(0, req.limit ?? 50),
          has_more: all.length > (req.limit ?? 50),
          ...(h ? { total_conversations: h.cleared ? 0 : h.conversations, total_bytes: h.cleared ? 4096 : h.bytes } : {}),
        });
        return;
      }
      case "history_clear":
        if (this.opts.history) this.opts.history.cleared = true;
        await this.reply({ type: "ok", id: req.id });
        return;
      case "agent_list":
        await this.reply({ type: "agents", id: req.id, agents: [...this.library.agents.values()] });
        return;
      case "agent_save": {
        const now = new Date().toISOString();
        const agent: Agent = { ...req.agent, name: req.agent.name.trim(), created_at: this.library.agents.get(req.agent.id)?.created_at ?? now, updated_at: now };
        this.library.agents.set(agent.id, agent);
        await this.reply({ type: "agent", id: req.id, agent });
        return;
      }
      case "agent_delete":
        if (!this.library.agents.delete(req.agent_id)) await this.reply({ type: "error", id: req.id, code: "E_NOT_FOUND" });
        else await this.reply({ type: "ok", id: req.id });
        return;
      case "skill_list":
        await this.reply({ type: "skills", id: req.id, skills: [...this.library.skills.values()] });
        return;
      case "skill_save": {
        const now = new Date().toISOString();
        const skill: Skill = { ...req.skill, name: req.skill.name.trim(), created_at: this.library.skills.get(req.skill.id)?.created_at ?? now, updated_at: now };
        this.library.skills.set(skill.id, skill);
        await this.reply({ type: "skill", id: req.id, skill });
        return;
      }
      case "skill_delete":
        if (!this.library.skills.delete(req.skill_id)) {
          await this.reply({ type: "error", id: req.id, code: "E_NOT_FOUND" });
          return;
        }
        for (const a of this.library.agents.values()) a.skill_ids = a.skill_ids.filter((id) => id !== req.skill_id);
        await this.reply({ type: "ok", id: req.id });
        return;
      case "history_get":
        await this.reply({
          type: "conversation",
          id: req.id,
          conversation: { id: req.conversation_id, title: "First", model: "llama3.2:3b", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:01:00Z" },
          messages: [
            { id: "m1", seq: 1, role: "user", content: "Oi", created_at: "2026-10-01T00:00:00Z", images: [TINY_JPEG_B64] },
            { id: "m2", seq: 2, role: "assistant", content: "Olá!", created_at: "2026-10-01T00:00:30Z", model: "llama3.2:3b" },
          ],
          has_more: false,
        });
        return;
    }
  }
}

export interface FakeRelayOptions {
  deviceOnline?: boolean;
  device?: FakeDeviceOptions;
  /** Pairing code the fake tray displays (claim = first 4). */
  pairingCode?: string;
  /** Reply to `open` with this relay error instead of `opened`. */
  openError?: string;
}

/**
 * Drives a FakeWebSocket like the relay would: answers hello/ping, routes `open`/`data` to a
 * FakeDevice, and plays the tray for `pair_*` frames. Call `attach()` after the client dialed.
 */
export class FakeRelay {
  ws!: FakeWebSocket;
  device: FakeDevice;
  clientId = "c0ffee0000000001";
  deviceOnline: boolean;
  pairingCode: string;
  pairedPK: Uint8Array | null = null;
  sessionOpen = false;
  pairResultOk = true;
  /** Transport to the client; defaults to the attached FakeWebSocket, replaceable by a real socket. */
  sender: (frame: unknown) => void = (frame) => this.ws.serverSend(frame);

  constructor(private readonly opts: FakeRelayOptions = {}) {
    this.deviceOnline = opts.deviceOnline ?? true;
    this.pairingCode = opts.pairingCode ?? "K7M3-ABCD-EFGH";
    this.device = new FakeDevice((payload) => this.toClient({ type: "data", device_id: this.device.deviceId, payload }), this.opts.device ?? {});
  }

  /** Bind to the latest FakeWebSocket, open it and answer the client's hello with welcome. */
  attach(ws: FakeWebSocket = FakeWebSocket.last): void {
    this.ws = ws;
    ws.serverOpen();
    // The client sets onmessage in dial(); wrap send so we can observe what it sends.
    const origSend = ws.send.bind(ws);
    ws.send = (data: string) => {
      origSend(data);
      void this.onClientFrame(JSON.parse(data) as Record<string, unknown>);
    };
    // hello was already sent synchronously in onopen → handle it now.
    for (const f of ws.frames()) void this.onClientFrame(f);
  }

  toClient(frame: unknown): void {
    this.sender(frame);
  }

  async onClientFrame(f: Record<string, unknown>): Promise<void> {
    switch (f.type) {
      case "hello":
        this.toClient({
          type: "welcome",
          v: 1,
          client_id: this.clientId,
          devices: [{ device_id: this.device.deviceId, name: "Office PC", online: this.deviceOnline }],
          limits: { max_frame_bytes: 1_048_576 },
        });
        return;
      case "ping":
        this.toClient({ type: "pong", t: f.t });
        return;
      case "open":
        if (this.opts.openError) {
          this.toClient({ type: "error", code: this.opts.openError, ref: f.device_id });
          return;
        }
        if (!this.deviceOnline) {
          this.toClient({ type: "error", code: "E_DEVICE_OFFLINE", ref: f.device_id });
          return;
        }
        this.sessionOpen = true;
        this.toClient({ type: "opened", device_id: f.device_id });
        return;
      case "close":
        this.sessionOpen = false;
        this.toClient({ type: "closed", device_id: f.device_id, reason: "client" });
        return;
      case "data":
        if (!this.sessionOpen) {
          this.toClient({ type: "error", code: "E_NO_SESSION", ref: f.device_id });
          return;
        }
        await this.device.onPayload(f.payload as JsonObject);
        return;
      case "pair_join": {
        const claim = this.pairingCode.replace(/-/g, "").slice(0, 4);
        if (f.claim !== claim) {
          this.toClient({ type: "error", code: "E_PAIR_NOT_FOUND" });
          return;
        }
        this.toClient({ type: "pair_joined", claim });
        return;
      }
      case "pair_msg": {
        const payload = f.payload as JsonObject;
        if (payload.t === "pake1") {
          const w = pairingCodeToW(this.pairingCode);
          const b = spake2B(TUNNELIO_SPAKE2, w, randomScalar(), b64urlDecode(String(payload.pA)));
          this.pendingPake = { cA: b.cA, Ke: b.Ke };
          this.toClient({ type: "pair_msg", claim: f.claim, payload: { t: "pake2", v: 1, pB: b64urlEncode(b.pB), cB: b64urlEncode(b.cB) } });
          return;
        }
        if (payload.t === "pake3") {
          const p = this.pendingPake;
          this.pendingPake = null;
          if (!p || !equalBytes(b64urlDecode(String(payload.cA)), p.cA) || !this.pairResultOk) {
            this.toClient({ type: "pair_result", claim: f.claim, ok: false, code: "E_PAIR_FAILED" });
            return;
          }
          this.pairedPK = pairingKeyFromKe(p.Ke);
          this.device.addPairing(this.pairedPK);
          this.toClient({ type: "pair_result", claim: f.claim, ok: true, device: { device_id: this.device.deviceId, name: "Office PC" } });
          return;
        }
        return;
      }
    }
  }
  private pendingPake: { cA: Uint8Array; Ke: Uint8Array } | null = null;

  setDeviceOnline(online: boolean): void {
    this.deviceOnline = online;
    if (!online) this.sessionOpen = false;
    this.toClient({ type: "device_status", device_id: this.device.deviceId, online });
  }
}
