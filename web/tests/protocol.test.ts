// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseServerFrame } from "../src/protocol/relay";
import { INBOUND_TYPES, OUTBOUND_TYPES, parseInboundMessage, validateOutbound, ChannelValidationError } from "../src/protocol/channel";
import { classifyPayload } from "../src/protocol/handshake";
import { Correlator, TimeoutError } from "../src/protocol/correlator";
import { createRequestIdGenerator, newRequestId } from "../src/protocol/ids";
import { PROTOCOL_VERSION, LIMITS } from "../src/protocol/constants";
import { relayUrl } from "../src/relay/url";
import { FakeTimers } from "./helpers/fake-timers";

describe("relay frame guards", () => {
  it("accepts well-formed server frames and rejects malformed ones", () => {
    expect(parseServerFrame({ type: "welcome", v: 1, client_id: "abc", devices: [], limits: { max_frame_bytes: 1 } })?.type).toBe("welcome");
    expect(parseServerFrame({ type: "welcome", v: 1, client_id: "abc", devices: [{ device_id: "d", name: "n" }], limits: { max_frame_bytes: 1 } })).toBeNull();
    expect(parseServerFrame({ type: "opened", device_id: "d" })?.type).toBe("opened");
    expect(parseServerFrame({ type: "opened" })).toBeNull();
    expect(parseServerFrame({ type: "data", device_id: "d", payload: { hs: "x" } })?.type).toBe("data");
    expect(parseServerFrame({ type: "data", device_id: "d", payload: "nope" })).toBeNull();
    expect(parseServerFrame({ type: "pair_result", claim: "K7M3", ok: true, device: { device_id: "d", name: "n" } })?.type).toBe("pair_result");
    expect(parseServerFrame({ type: "pair_result", claim: "K7M3", ok: "yes" })).toBeNull();
    expect(parseServerFrame({ type: "device_status", device_id: "d", online: true })?.type).toBe("device_status");
    expect(parseServerFrame({ type: "error", code: "E_RATE_LIMIT", retry_after_ms: 500 })?.type).toBe("error");
    expect(parseServerFrame({ type: "bogus" })).toBeNull();
    expect(parseServerFrame("hello")).toBeNull();
    expect(parseServerFrame({ type: "closed", device_id: "d" })).toMatchObject({ reason: "" });
  });
});

describe("handshake payload classification", () => {
  it("separates handshake, envelope and invalid payloads", () => {
    expect(classifyPayload({ hs: "hello_ack", v: 1, eph_pub: "a", mac: "b" }).kind).toBe("handshake");
    expect(classifyPayload({ hs: "reject", v: 1, code: "E_UNKNOWN_PAIRING" }).kind).toBe("handshake");
    expect(classifyPayload({ hs: "reject", v: 1, code: "E_WHAT" }).kind).toBe("invalid");
    expect(classifyPayload({ v: 1, device_id: "d", nonce: "n", ciphertext: "c" }).kind).toBe("envelope");
    expect(classifyPayload({ v: 1, device_id: "d" }).kind).toBe("invalid");
    expect(classifyPayload({}).kind).toBe("invalid");
  });
});

describe("channel message guards", () => {
  it("has the exact inbound allowlist from SPEC §7.4", () => {
    expect([...INBOUND_TYPES]).toEqual([
      "device_info", "models", "running", "model_info", "chat_chunk", "chat_done",
      "pull_progress", "pull_done", "history", "conversation", "agents", "agent", "skills", "skill", "ok", "error",
    ]);
    expect([...OUTBOUND_TYPES]).toEqual([
      "list_models", "list_running", "show_model", "chat", "abort", "pull_model", "delete_model",
      "history_list", "history_get", "history_delete", "history_clear",
      "agent_list", "agent_save", "agent_delete", "skill_list", "skill_save", "skill_delete",
    ]);
  });
  it("validates known types and reports unknown ones", () => {
    expect(parseInboundMessage({ type: "ok", id: "r1" })).toMatchObject({ ok: true });
    expect(parseInboundMessage({ type: "ok" })).toMatchObject({ ok: false, reason: "malformed" });
    expect(parseInboundMessage({ type: "exec", id: "r1" })).toMatchObject({ ok: false, reason: "unknown_type", type: "exec" });
    expect(parseInboundMessage({ type: "chat_chunk", id: "r1", content: "x", thinking: "y", extra: 1 })).toMatchObject({ ok: true });
    expect(parseInboundMessage({ type: "chat_done", id: "r1", conversation_id: "c", done_reason: "stop" })).toMatchObject({ ok: true });
    expect(parseInboundMessage({ type: "chat_done", id: "r1", conversation_id: "c", done_reason: "nope" })).toMatchObject({ ok: false });
    expect(parseInboundMessage({ type: "models", id: "r1", models: [{ name: "m", size: 1, modified_at: "t", digest: "d", details: {} }] })).toMatchObject({ ok: true });
    expect(parseInboundMessage({ type: "models", id: "r1", models: [{ name: "m" }] })).toMatchObject({ ok: false });
    expect(parseInboundMessage({ type: "error", code: "E_BUSY", retry_after_ms: 10 })).toMatchObject({ ok: true });
    expect(parseInboundMessage(null)).toMatchObject({ ok: false });
  });
  it("validates outbound requests early", () => {
    expect(() => validateOutbound({ type: "list_models", id: "r1" })).not.toThrow();
    expect(() => validateOutbound({ type: "list_models", id: "" })).toThrow(ChannelValidationError);
    expect(() => validateOutbound({ type: "chat", id: "r", conversation_id: "c", mode: "private", model: "m", messages: [] })).toThrow(/1–500/);
    expect(() => validateOutbound({ type: "chat", id: "r", conversation_id: "c", mode: "cloud" as never, model: "m", messages: [{ role: "user", content: "hi" }] })).toThrow(/mode/);
    expect(() => validateOutbound({ type: "chat", id: "r", conversation_id: "c", mode: "private", model: "m", messages: [{ role: "user", content: "hi" }], title: "t".repeat(LIMITS.CHAT_TITLE_MAX_BYTES + 1) })).toThrow(/title/);
    expect(() => validateOutbound({ type: "history_list", id: "r", limit: 101 })).toThrow(/limit/);
    expect(() => validateOutbound({ type: "history_get", id: "r", conversation_id: "c", after_seq: -1 })).toThrow(/after_seq/);
    const big = "x".repeat(LIMITS.MAX_MESSAGE_BYTES);
    expect(() => validateOutbound({ type: "chat", id: "r", conversation_id: "c", mode: "private", model: "m", messages: [{ role: "user", content: big }] })).toThrow(/8 MiB/);
  });
  it("enforces the image contract on chat messages (count, size, role, encoding)", () => {
    const chat = (messages: { role: "user" | "assistant" | "system"; content: string; images?: string[] }[]) =>
      validateOutbound({ type: "chat", id: "r", conversation_id: "c", mode: "private", model: "m", messages });
    const img = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString("base64");
    expect(() => chat([{ role: "user", content: "", images: [img] }])).not.toThrow(); // empty text + image is fine
    expect(() => chat([{ role: "user", content: "x", images: [] }])).not.toThrow();
    expect(() => chat([{ role: "user", content: "x", images: [img, img, img, img] }])).not.toThrow();
    expect(() => chat([{ role: "user", content: "x", images: [img, img, img, img, img] }])).toThrow(/at most 4/);
    expect(() => chat([{ role: "assistant", content: "x", images: [img] }])).toThrow(/only user/);
    expect(() => chat([{ role: "user", content: "x", images: [`data:image/jpeg;base64,${img}`] }])).toThrow(/base64/);
    expect(() => chat([{ role: "user", content: "x", images: ["/9j/4A"] }])).toThrow(/base64/); // unpadded
    expect(() => chat([{ role: "user", content: "x", images: ["_9j_4AA="] }])).toThrow(/base64/); // base64url alphabet
    expect(() => chat([{ role: "user", content: "x", images: [12 as unknown as string] }])).toThrow(/array/);
    const b64OfLength = (n: number) => "A".repeat(Math.floor(n / 3) * 4) + (n % 3 === 1 ? "AA==" : n % 3 === 2 ? "AAA=" : "");
    const fourMiB = b64OfLength(LIMITS.MAX_IMAGE_BYTES);
    expect(() => chat([{ role: "user", content: "x", images: [fourMiB] }])).not.toThrow();
    expect(() => chat([{ role: "user", content: "x", images: [b64OfLength(LIMITS.MAX_IMAGE_BYTES + 1)] }])).toThrow(/4 MiB/);
    // Two 4 MiB images + base64 overhead exceed the 8 MiB plaintext cap.
    expect(() => chat([{ role: "user", content: "x", images: [fourMiB, fourMiB] }])).toThrow(/8 MiB/);
    expect(LIMITS.MAX_MESSAGE_BYTES).toBe(8_388_608);
    expect(LIMITS.MAX_IMAGES_PER_MESSAGE).toBe(4);
    expect(LIMITS.MAX_IMAGE_BYTES).toBe(4_194_304);
  });
  it("accepts device_info with the image limits and history messages with images", () => {
    const info = {
      type: "device_info", protocol_versions: [1], tray_version: "0.2.0", platform: "linux", ollama: { status: "running" },
      limits: { max_message_bytes: 8_388_608, chat_concurrency: 1, pull_concurrency: 1, max_images_per_message: 4, max_image_bytes: 4_194_304 },
      capabilities: ["history", "think", "images"],
    };
    expect(parseInboundMessage(info)).toMatchObject({ ok: true });
    expect(parseInboundMessage({ ...info, limits: { ...info.limits, max_image_bytes: "big" } })).toMatchObject({ ok: false });
    const conv = {
      type: "conversation", id: "r", conversation: { id: "c", title: "t", model: "m", created_at: "t", updated_at: "t" }, has_more: false,
      messages: [{ id: "m1", seq: 1, role: "user", content: "", created_at: "t", images: ["/9j/4AA="] }],
    };
    expect(parseInboundMessage(conv)).toMatchObject({ ok: true });
    expect(parseInboundMessage({ ...conv, messages: [{ ...conv.messages[0], images: "nope" }] })).toMatchObject({ ok: false });
  });
});

describe("request ids", () => {
  it("are unique, short and prefixed", () => {
    const g = createRequestIdGenerator("q");
    const a = g.next();
    const b = g.next();
    expect(a).not.toBe(b);
    expect(a.startsWith("q")).toBe(true);
    expect(newRequestId().length).toBeLessThanOrEqual(LIMITS.REQUEST_ID_MAX_LENGTH);
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe("relayUrl", () => {
  it("derives ws(s)://host/ws/client from a base URL", () => {
    expect(relayUrl("http://localhost:8080")).toBe("ws://localhost:8080/ws/client");
    expect(relayUrl("https://tunnelio.app/some/path?x=1")).toBe("wss://tunnelio.app/ws/client");
    expect(relayUrl("wss://h/")).toBe("wss://h/ws/client");
    expect(() => relayUrl("ftp://h")).toThrow();
  });
});

describe("Correlator", () => {
  type M = { type: string; id?: string; n?: number };
  it("resolves requests by id and times out", async () => {
    const timers = new FakeTimers();
    const c = new Correlator<M>(timers);
    const p = c.request("a", 1000);
    expect(c.dispatch({ type: "x", id: "zzz" })).toBe(false);
    expect(c.dispatch({ type: "ok", id: "a" })).toBe(true);
    await expect(p).resolves.toEqual({ type: "ok", id: "a" });
    const q = c.request("b", 1000);
    const qRejects = expect(q).rejects.toBeInstanceOf(TimeoutError);
    await timers.advance(999);
    expect(c.has("b")).toBe(true);
    await timers.advance(1);
    await qRejects;
    expect(c.size).toBe(0);
  });
  it("streams events until the terminal message, with idle timeout", async () => {
    const timers = new FakeTimers();
    const c = new Correlator<M>(timers);
    const got: number[] = [];
    const p = c.stream("s", { idleMs: 100, onEvent: (m) => got.push(m.n ?? -1), isDone: (m) => m.type === "done" });
    c.dispatch({ type: "chunk", id: "s", n: 1 });
    await timers.advance(90);
    c.dispatch({ type: "chunk", id: "s", n: 2 });
    await timers.advance(90);
    c.dispatch({ type: "done", id: "s" });
    await expect(p).resolves.toEqual({ type: "done", id: "s" });
    expect(got).toEqual([1, 2]);
    const stalled: number[] = [];
    const t0 = timers.now();
    const q = c.stream("t", { idleMs: 100, onEvent: () => undefined, isDone: (m) => m.type === "done", onIdle: () => stalled.push(timers.now() - t0) });
    await timers.advance(250);
    expect(stalled).toEqual([100, 200]);
    expect(c.has("t")).toBe(true);
    c.dispatch({ type: "done", id: "t" });
    await expect(q).resolves.toMatchObject({ type: "done" });
    const r = c.stream("u", { idleMs: 100, onEvent: () => undefined, isDone: (m) => m.type === "done" });
    const rRejects = expect(r).rejects.toMatchObject({ kind: "idle" });
    await timers.advance(100);
    await rRejects;
  });
  it("terminates a stream on an error message and rejects everything on rejectAll", async () => {
    const timers = new FakeTimers();
    const c = new Correlator<M>(timers);
    const p = c.stream("s", { idleMs: 100, onEvent: () => undefined, isDone: (m) => m.type === "done" });
    c.dispatch({ type: "error", id: "s" });
    await expect(p).resolves.toMatchObject({ type: "error" });
    const q = c.request("x", 1000);
    c.rejectAll(new Error("bye"));
    await expect(q).rejects.toThrow("bye");
    const first = c.request("dup", 1000);
    first.catch(() => undefined);
    await expect(c.request("dup", 1000)).rejects.toThrow(/duplicate/);
    c.cancel("dup");
    await expect(first).rejects.toThrow(/cancelled/);
  });
});
