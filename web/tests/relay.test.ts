// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { RelayClient, RelayError } from "../src/relay/client";
import type { RelayStateChange } from "../src/relay/client";
import { FakeTimers } from "./helpers/fake-timers";
import { FakeWebSocket } from "./helpers/fake-ws";

function makeClient(timers: FakeTimers, random = () => 0.5) {
  return new RelayClient({
    url: "ws://test/ws/client",
    appVersion: "0.0.0-test",
    WebSocket: FakeWebSocket,
    timers,
    random,
    log: () => undefined,
  });
}

const WELCOME = { type: "welcome", v: 1, client_id: "c1", devices: [{ device_id: "d1", name: "PC", online: true }], limits: { max_frame_bytes: 1048576 } };

describe("RelayClient", () => {
  let timers: FakeTimers;
  beforeEach(() => {
    FakeWebSocket.reset();
    timers = new FakeTimers();
  });

  it("dials with the subprotocol, sends hello first and becomes ready on welcome", async () => {
    const c = makeClient(timers);
    const states: RelayStateChange[] = [];
    c.on("state", (s) => states.push(s));
    c.connect();
    const ws = FakeWebSocket.last;
    expect(ws.url).toBe("ws://test/ws/client");
    expect(ws.protocols).toEqual(["tunnelio.v1"]);
    expect(c.state).toBe("connecting");
    expect(() => c.openSession("d1")).toThrow(RelayError);
    ws.serverOpen();
    expect(ws.frames()).toEqual([{ type: "hello", v: 1, app: "web", version: "0.0.0-test" }]);
    let welcome: unknown = null;
    c.on("welcome", (w) => (welcome = w));
    ws.serverSend(WELCOME);
    expect(c.state).toBe("ready");
    expect(c.clientId).toBe("c1");
    expect(c.limits).toEqual({ max_frame_bytes: 1048576 });
    expect(welcome).toMatchObject({ client_id: "c1" });
    expect(states.map((s) => s.state)).toEqual(["connecting", "ready"]);
    c.openSession("d1");
    c.sendData("d1", { v: 1 });
    c.pairJoin("K7M3");
    c.pairMsg("K7M3", { t: "pake1" });
    c.closeSession("d1");
    expect(ws.frames().slice(1).map((f) => f.type)).toEqual(["open", "data", "pair_join", "pair_msg", "close"]);
  });

  it("routes server frames to typed events and ignores unknown/malformed ones", () => {
    const c = makeClient(timers);
    c.connect();
    const ws = FakeWebSocket.last;
    ws.serverOpen();
    ws.serverSend(WELCOME);
    const seen: string[] = [];
    for (const ev of ["opened", "closed", "data", "pair_joined", "pair_msg", "pair_result", "device_status", "error"] as const) {
      c.on(ev, () => seen.push(ev));
    }
    ws.serverSend({ type: "opened", device_id: "d1" });
    ws.serverSend({ type: "closed", device_id: "d1", reason: "x" });
    ws.serverSend({ type: "data", device_id: "d1", payload: {} });
    ws.serverSend({ type: "pair_joined", claim: "K7M3" });
    ws.serverSend({ type: "pair_msg", claim: "K7M3", payload: {} });
    ws.serverSend({ type: "pair_result", claim: "K7M3", ok: false, code: "E_PAIR_FAILED" });
    ws.serverSend({ type: "device_status", device_id: "d1", online: false });
    ws.serverSend({ type: "error", code: "E_NOT_FOUND" });
    ws.serverSend({ type: "whatever" });
    ws.serverSend("not json");
    ws.serverSend({ type: "opened" });
    expect(seen).toEqual(["opened", "closed", "data", "pair_joined", "pair_msg", "pair_result", "device_status", "error"]);
  });

  it("pings every 30 s, answers server pings, and drops the socket after 45 s without pong", async () => {
    const c = makeClient(timers);
    c.connect();
    const ws = FakeWebSocket.last;
    ws.serverOpen();
    ws.serverSend(WELCOME);
    ws.takeFrames();
    await timers.advance(30_000);
    expect(ws.frames()).toEqual([{ type: "ping", t: 30_000 }]);
    ws.serverSend({ type: "pong", t: 30_000 });
    ws.serverSend({ type: "ping", t: 31 });
    expect(ws.frames()[1]).toEqual({ type: "pong", t: 31 });
    ws.takeFrames();
    await timers.advance(30_000); // second ping at 60 s, no pong
    expect(ws.framesOf("ping").length).toBe(1);
    const disconnected: unknown[] = [];
    c.on("disconnected", (d) => disconnected.push(d));
    await timers.advance(44_999);
    expect(c.state).toBe("ready");
    await timers.advance(1); // 45 s after the unanswered ping
    expect(ws.closedWith).toMatchObject({ code: 4000 });
    expect(disconnected).toEqual([{ code: 4000, reason: "pong timeout", willReconnect: true }]);
    expect(c.state).toBe("waiting");
  });

  it("reconnects with full-jitter exponential backoff and resets after 60 s stable", async () => {
    const c = makeClient(timers, () => 1); // worst-case jitter → delay = cap
    c.connect();
    let ws = FakeWebSocket.last;
    const waits: number[] = [];
    c.on("state", (s) => {
      if (s.state === "waiting") waits.push(s.delayMs ?? -1);
    });
    ws.serverClose(1006, "");
    expect(c.state).toBe("waiting");
    await timers.advance(1000);
    expect(FakeWebSocket.instances.length).toBe(2);
    ws = FakeWebSocket.last;
    ws.serverClose(1006, "");
    await timers.advance(2000);
    ws = FakeWebSocket.last;
    ws.serverClose(1006, "");
    await timers.advance(4000);
    expect(waits).toEqual([1000, 2000, 4000]);
    // 10 more failures must cap at 60 s
    for (let i = 0; i < 10; i++) {
      FakeWebSocket.last.serverClose(1006, "");
      await timers.advance(60_000);
    }
    expect(Math.max(...waits)).toBe(60_000);
    // Now succeed and stay stable for 60 s → attempt counter resets.
    ws = FakeWebSocket.last;
    ws.serverOpen();
    ws.serverSend(WELCOME);
    await timers.advance(60_000);
    ws.serverClose(4005, "shutting down");
    expect(waits[waits.length - 1]).toBe(1000);
    expect(c.state).toBe("waiting");
  });

  it("stops on 4001 (auth lost) and 4002 (fatal), surfaces 4003/4004 and reconnects", async () => {
    const c = makeClient(timers);
    const events: string[] = [];
    c.on("auth_lost", () => events.push("auth_lost"));
    c.on("fatal", () => events.push("fatal"));
    c.on("error", (e) => events.push("error:" + e.code));
    c.on("disconnected", (d) => events.push(`disc:${d.code}:${d.willReconnect}`));
    c.connect();
    FakeWebSocket.last.serverClose(4001, "session invalid");
    expect(c.state).toBe("closed");
    await timers.advance(120_000);
    expect(FakeWebSocket.instances.length).toBe(1);
    c.connect();
    expect(FakeWebSocket.instances.length).toBe(2);
    FakeWebSocket.last.serverClose(4002, "bad frame");
    expect(c.state).toBe("closed");
    c.connect();
    FakeWebSocket.last.serverClose(4003, "rate");
    expect(c.state).toBe("waiting");
    await timers.advance(60_000);
    FakeWebSocket.last.serverClose(4004, "big");
    await timers.advance(60_000);
    expect(events).toEqual([
      "auth_lost", "disc:4001:false",
      "fatal", "disc:4002:false",
      "error:E_RATE_LIMIT", "disc:4003:true",
      "error:E_TOO_LARGE", "disc:4004:true",
    ]);
  });

  it("disconnect() closes with 1000 and never reconnects; whenReady resolves/rejects properly", async () => {
    const c = makeClient(timers);
    // idle (connect() not called yet) waits for a connection, bounded by the timeout
    const idle = c.whenReady(500);
    const idleRejects = expect(idle).rejects.toMatchObject({ code: "E_TIMEOUT" });
    await timers.advance(500);
    await idleRejects;
    c.connect();
    const ready = c.whenReady(5000);
    const ws = FakeWebSocket.last;
    ws.serverOpen();
    ws.serverSend(WELCOME);
    await expect(ready).resolves.toBeUndefined();
    await expect(c.whenReady()).resolves.toBeUndefined();
    c.disconnect();
    expect(ws.closedWith).toMatchObject({ code: 1000 });
    expect(c.state).toBe("closed");
    await timers.advance(120_000);
    expect(FakeWebSocket.instances.length).toBe(1);
    c.connect();
    const p = c.whenReady(1000);
    const pRejects = expect(p).rejects.toMatchObject({ code: "E_TIMEOUT" });
    await timers.advance(1000);
    await pRejects;
  });

  it("drops a socket that never sends welcome and rejects a wrong subprotocol", async () => {
    const c = makeClient(timers);
    c.connect();
    const ws = FakeWebSocket.last;
    ws.serverOpen();
    await timers.advance(15_000);
    expect(ws.closedWith).toMatchObject({ code: 4000, reason: "welcome timeout" });
    expect(c.state).toBe("waiting");
    await timers.advance(1000);
    const ws2 = FakeWebSocket.last;
    ws2.protocol = "other";
    const fatal: unknown[] = [];
    c.on("fatal", (f) => fatal.push(f));
    ws2.serverOpen();
    expect(fatal.length).toBe(1);
    expect(c.state).toBe("closed");
  });
});
