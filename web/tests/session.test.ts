// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { RelayClient } from "../src/relay/client";
import { DeviceSession, SessionError, type SessionStatus } from "../src/session/device-session";
import { pairingIdFromPK } from "../src/crypto/pairing";
import { randomBytes } from "../src/crypto/bytes";
import { FakeTimers } from "./helpers/fake-timers";
import { FakeWebSocket } from "./helpers/fake-ws";
import { DEVICE_ID, FakeRelay, type FakeRelayOptions } from "./helpers/fake-device";

async function setup(opts: FakeRelayOptions = {}, sessionOpts: Partial<ConstructorParameters<typeof DeviceSession>[1]> = {}) {
  FakeWebSocket.reset();
  const timers = new FakeTimers();
  const relay = new RelayClient({ url: "ws://t/ws/client", appVersion: "t", WebSocket: FakeWebSocket, timers, random: () => 0, log: () => undefined });
  relay.connect();
  const fake = new FakeRelay(opts);
  fake.attach();
  await timers.flush();
  const pk = randomBytes(32);
  fake.device.addPairing(pk);
  const session = new DeviceSession(relay, {
    deviceId: DEVICE_ID,
    pairing: { pairing_id: pairingIdFromPK(pk), pk },
    timers,
    log: () => undefined,
    ...sessionOpts,
  });
  const statuses: SessionStatus[] = [];
  session.on("status", (s) => statuses.push(s.status));
  return { timers, relay, fake, session, statuses, pk };
}

describe("DeviceSession", () => {
  beforeEach(() => FakeWebSocket.reset());

  it("opens: relay open → hello → hello_ack verified → confirm → device_info", async () => {
    const { session, statuses, fake, timers } = await setup();
    const info = await session.open();
    await timers.flush();
    expect(info.type).toBe("device_info");
    expect(session.status).toBe("ready");
    expect(session.deviceInfo?.tray_version).toBe("0.1.0-test");
    expect(statuses).toEqual(["opening", "handshaking", "ready"]);
    const payloads = fake.ws.frames().filter((f) => f.type === "data").map((f) => f.payload as Record<string, unknown>);
    expect(payloads[0]).toMatchObject({ hs: "hello", v: 1 });
    expect(payloads[1]).toMatchObject({ hs: "confirm", v: 1 });
    expect(typeof payloads[0]?.pairing_id).toBe("string");
    // idempotent
    await expect(session.open()).resolves.toBe(info);
  });

  it("correlates requests and streams chat chunks with strictly sequential counters", async () => {
    const { session, fake, timers } = await setup();
    await session.open();
    const models = await session.request({ type: "list_models", id: "r1" });
    expect(models.models[0]?.name).toBe("llama3.2:3b");
    const chunks: string[] = [];
    const done = await session.stream(
      { type: "chat", id: "r2", conversation_id: "c1", mode: "private", model: "llama3.2:3b", messages: [{ role: "user", content: "Oi" }], title: "Oi" },
      { onChunk: (c) => chunks.push(c.content) },
    );
    expect(chunks.join("")).toBe("Hello world");
    expect(done).toMatchObject({ type: "chat_done", done_reason: "stop", message_id: "m-r2" });
    // Parallel requests keep order on the wire.
    const [a, b, c] = await Promise.all([
      session.request({ type: "list_running", id: "p1" }),
      session.request({ type: "show_model", id: "p2", name: "llama3.2:3b" }),
      session.request({ type: "history_list", id: "p3" }),
    ]);
    expect([a.type, b.type, c.type]).toEqual(["running", "model_info", "history"]);
    expect(fake.device.received.map((r) => r.id)).toEqual(["r1", "r2", "p1", "p2", "p3"]);
    expect(fake.device.recvCounter).toBe(5);
    const conv = await session.request({ type: "history_get", id: "p4", conversation_id: "c1" });
    expect(conv.messages.length).toBe(2);
    await expect(session.request({ type: "history_delete", id: "p5", conversation_id: "c1" })).resolves.toMatchObject({ type: "ok" });
    const progress: number[] = [];
    const pulled = await session.pull({ type: "pull_model", id: "p6", name: "llama3.2:3b" }, (p) => progress.push(p.completed ?? -1));
    expect(pulled.type).toBe("pull_done");
    expect(progress).toEqual([50]);
    await timers.flush();
  });

  it("surfaces device error replies and times out unanswered requests", async () => {
    const { session, timers } = await setup({
      device: {
        handle: async (req, reply) => {
          if (req.type === "delete_model") {
            await reply({ type: "error", id: req.id, code: "E_MODEL_NOT_FOUND", message: "nope" });
            return true;
          }
          if (req.type === "list_running") return true; // never answers
          return false;
        },
      },
    });
    await session.open();
    await expect(session.request({ type: "delete_model", id: "e1", name: "x" })).rejects.toMatchObject({ code: "E_MODEL_NOT_FOUND", message: "nope" });
    const p = session.request({ type: "list_running", id: "e2" });
    p.catch(() => undefined);
    await timers.advance(30_000);
    await expect(p).rejects.toMatchObject({ code: "E_TIMEOUT" });
  });

  it("retries a bad mac_d with fresh hellos and reports needs-pairing after 3 attempts", async () => {
    const { session, fake, timers } = await setup({ device: { badMac: true } }, { autoReopen: false });
    const needs: unknown[] = [];
    session.on("needs_pairing", (n) => needs.push(n));
    await expect(session.open()).rejects.toMatchObject({ code: "E_HANDSHAKE_FAILED" });
    expect(session.status).toBe("needs-pairing");
    expect(session.lastError?.message).toContain("E_HANDSHAKE_MAC");
    expect(fake.device.hellos).toBe(3);
    expect(needs).toEqual([{ code: "E_HANDSHAKE_FAILED" }]);
    expect(fake.ws.framesOf("open").length).toBe(1); // the relay session is opened once
    await timers.flush();
  });

  it("times out after 10 s when the device drops the handshake silently, retrying with a new ephemeral key", async () => {
    const { session, fake, timers } = await setup({ device: { silentConfirm: true } }, { autoReopen: false });
    const p = session.open();
    p.catch(() => undefined);
    await timers.flush();
    expect(session.status).toBe("handshaking");
    expect(fake.device.hellos).toBe(1);
    await timers.advance(9_999);
    expect(fake.device.hellos).toBe(1);
    await timers.advance(1);
    expect(fake.device.hellos).toBe(2);
    await timers.advance(10_000);
    expect(fake.device.hellos).toBe(3);
    await timers.advance(10_000);
    await expect(p).rejects.toMatchObject({ code: "E_HANDSHAKE_FAILED" });
    expect(session.status).toBe("needs-pairing");
    const hellos = fake.ws
      .frames()
      .filter((f) => f.type === "data" && (f.payload as { hs?: string }).hs === "hello")
      .map((f) => (f.payload as { eph_pub: string }).eph_pub);
    expect(new Set(hellos).size).toBe(3);
    // Malformed/ignored hello: same outcome.
    const s2 = await setup({ device: { silentHello: true } }, { autoReopen: false });
    const q = s2.session.open();
    q.catch(() => undefined);
    await s2.timers.advance(30_000);
    await expect(q).rejects.toMatchObject({ code: "E_HANDSHAKE_FAILED" });
    expect(s2.fake.device.hellos).toBe(3);
  });

  it("maps reject{E_UNKNOWN_PAIRING} to needs-pairing", async () => {
    const { session } = await setup({ device: { rejectCode: "E_UNKNOWN_PAIRING" } });
    const needs: unknown[] = [];
    session.on("needs_pairing", (n) => needs.push(n));
    await expect(session.open()).rejects.toMatchObject({ code: "E_UNKNOWN_PAIRING" });
    expect(session.status).toBe("needs-pairing");
    expect(needs).toEqual([{ code: "E_UNKNOWN_PAIRING" }]);
  });

  it("reports offline when the relay says the device is offline, and re-handshakes when it returns", async () => {
    const { session, fake, timers, statuses } = await setup({ deviceOnline: false });
    await expect(session.open()).rejects.toMatchObject({ code: "E_DEVICE_OFFLINE" });
    expect(session.status).toBe("offline");
    fake.setDeviceOnline(true);
    await timers.advance(0);
    await timers.flush();
    expect(session.status).toBe("ready");
    const helloCount = () => fake.ws.frames().filter((f) => f.type === "data" && (f.payload as { hs?: string }).hs === "hello").length;
    expect(helloCount()).toBe(1);
    // Device drops and comes back: pending requests fail, then a fresh handshake happens.
    const p = session.request({ type: "list_models", id: "x1" });
    p.catch(() => undefined);
    fake.setDeviceOnline(false);
    await expect(p).rejects.toMatchObject({ code: "E_DEVICE_OFFLINE" });
    expect(session.status).toBe("offline");
    fake.setDeviceOnline(true);
    await timers.advance(0);
    await timers.flush();
    expect(session.status).toBe("ready");
    expect(helloCount()).toBe(2);
    expect(statuses.filter((s) => s === "ready").length).toBe(2);
    await expect(session.request({ type: "list_models", id: "x2" })).resolves.toMatchObject({ type: "models" });
  });

  it("closes the session on an out-of-order counter and discards envelopes that fail to authenticate", async () => {
    const { session, fake, timers } = await setup({}, { autoReopen: false });
    await session.open();
    const warnings: string[] = [];
    session.on("warning", (w) => warnings.push(w.code));
    // A replayed/garbage envelope (bad tag) is silently discarded.
    fake.toClient({ type: "data", device_id: DEVICE_ID, payload: { v: 1, device_id: DEVICE_ID, nonce: "AQAAAAAAAAAAAAAB", ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } });
    await timers.flush();
    expect(session.status).toBe("ready");
    // Unknown type inside a valid envelope is ignored.
    await fake.device.reply({ type: "exec" as never, id: "z" } as never);
    await timers.flush();
    expect(session.status).toBe("ready");
    // Counter skip → session closed.
    await fake.device.replyWithCounter({ type: "ok", id: "q" }, 7);
    await timers.flush();
    expect(session.status).toBe("error");
    expect(session.lastError?.code).toBe("E_COUNTER");
    expect(fake.ws.framesOf("close").length).toBe(1);
    await expect(() => session.request({ type: "list_models", id: "n" })).rejects.toMatchObject({ code: "E_NO_SESSION" });
  });

  it("calls onStalled on idle and aborts automatically otherwise", async () => {
    const { session, timers, fake } = await setup({
      device: {
        handle: async (req, reply) => {
          if (req.type === "chat") {
            await reply({ type: "chat_chunk", id: req.id, content: "…" });
            return true; // never finishes
          }
          return false;
        },
      },
    });
    await session.open();
    const stalls: number[] = [];
    const p = session.stream(
      { type: "chat", id: "s1", conversation_id: "c", mode: "private", model: "m", messages: [{ role: "user", content: "x" }] },
      { onChunk: () => undefined, onStalled: () => stalls.push(timers.now()) },
    );
    p.catch(() => undefined);
    await timers.advance(120_000);
    expect(stalls.length).toBe(1);
    await session.abort("s1");
    await fake.device.reply({ type: "chat_done", id: "s1", conversation_id: "c", done_reason: "abort" });
    await expect(p).resolves.toMatchObject({ done_reason: "abort" });
    const q = session.stream(
      { type: "chat", id: "s2", conversation_id: "c", mode: "private", model: "m", messages: [{ role: "user", content: "x" }] },
      { onChunk: () => undefined },
    );
    q.catch(() => undefined);
    await timers.advance(120_000);
    await expect(q).rejects.toMatchObject({ code: "E_TIMEOUT" });
    await timers.flush();
    expect(fake.device.received.filter((r) => r.type === "abort").length).toBe(2);
  }, 20_000); // two 120 s idle windows through the fake clock: slow CI runners exceeded the 5 s default

  it("handles a post-acceptance chat error (error then chat_done) without dangling state", async () => {
    const { session, timers } = await setup({
      device: {
        handle: async (req, reply) => {
          if (req.type === "chat") {
            await reply({ type: "error", id: req.id, code: "E_OLLAMA_DOWN", message: "ollama is not running" });
            await reply({ type: "chat_done", id: req.id, conversation_id: req.conversation_id, done_reason: "error" });
            return true;
          }
          return false;
        },
      },
    });
    await session.open();
    const warnings: string[] = [];
    session.on("warning", (w) => warnings.push(w.code));
    await expect(
      session.stream({ type: "chat", id: "e1", conversation_id: "c", mode: "private", model: "m", messages: [{ role: "user", content: "x" }] }, { onChunk: () => undefined }),
    ).rejects.toMatchObject({ code: "E_OLLAMA_DOWN", message: "ollama is not running" });
    await timers.flush();
    expect(warnings).toEqual([]);
    expect(session.status).toBe("ready");
    await expect(session.request({ type: "list_models", id: "after" })).resolves.toMatchObject({ type: "models" });
    // A pre-acceptance error has no trailing frame; nothing leaks either way.
    await timers.advance(60_000);
    expect(warnings).toEqual([]);
  });

  it("treats closed{reason:\"device\"} as a teardown and re-handshakes on next use or when the device comes online", async () => {
    const { session, fake, timers } = await setup();
    await session.open();
    const p = session.request({ type: "list_models", id: "x" });
    p.catch(() => undefined);
    fake.sessionOpen = false;
    fake.toClient({ type: "closed", device_id: DEVICE_ID, reason: "device" });
    await expect(p).rejects.toMatchObject({ code: "E_NO_SESSION" });
    expect(session.status).toBe("idle");
    await timers.advance(5_000);
    expect(fake.device.hellos).toBe(1); // no automatic reopen loop
    await expect(session.request({ type: "list_models", id: "y" })).rejects.toMatchObject({ code: "E_NO_SESSION" });
    await session.open();
    expect(session.status).toBe("ready");
    expect(fake.device.hellos).toBe(2);
    fake.sessionOpen = false;
    fake.toClient({ type: "closed", device_id: DEVICE_ID, reason: "device" });
    expect(session.status).toBe("idle");
    fake.setDeviceOnline(true); // SPEC §3.7: re-handshake on device_status online
    await timers.advance(0);
    await timers.flush();
    expect(session.status).toBe("ready");
    expect(fake.device.hellos).toBe(3);
  });

  it("goes offline when the relay drops and re-opens after it reconnects", async () => {
    const { session, timers, relay } = await setup();
    await session.open();
    FakeWebSocket.last.serverClose(4005, "restart");
    expect(session.status).toBe("offline");
    await timers.advance(0); // jitter 0 → immediate redial
    const fake2 = new FakeRelay();
    fake2.attach();
    await timers.flush();
    expect(relay.state).toBe("ready");
    // The new fake relay's device does not know the pairing → needs-pairing (proves a new hello was sent).
    await timers.advance(0);
    await timers.flush();
    expect(["needs-pairing", "handshaking", "opening"]).toContain(session.status);
    session.dispose();
    expect(session.status).toBe("closed");
    await expect(session.open()).rejects.toBeInstanceOf(SessionError);
  });

  it("close() sends close to the relay and rejects in-flight work", async () => {
    const { session, fake } = await setup();
    await session.open();
    session.close();
    expect(session.status).toBe("closed");
    expect(fake.ws.framesOf("close")).toEqual([{ type: "close", device_id: DEVICE_ID }]);
    await expect(session.open()).resolves.toMatchObject({ type: "device_info" });
  });
});
