// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { RelayClient } from "../src/relay/client";
import { pairDevice, PairingError } from "../src/pairing/flow";
import { pairingIdFromPK } from "../src/crypto/pairing";
import { bytesToHex } from "../src/crypto/bytes";
import { createMemoryStorage } from "../src/lib/storage";
import { DeviceSession } from "../src/session/device-session";
import { FakeTimers } from "./helpers/fake-timers";
import { FakeWebSocket } from "./helpers/fake-ws";
import { FakeRelay, type FakeRelayOptions } from "./helpers/fake-device";

async function setup(opts: FakeRelayOptions = {}) {
  FakeWebSocket.reset();
  const timers = new FakeTimers();
  const relay = new RelayClient({ url: "ws://t/ws/client", appVersion: "t", WebSocket: FakeWebSocket, timers, random: () => 0, log: () => undefined });
  relay.connect();
  const fake = new FakeRelay(opts);
  fake.attach();
  await timers.flush();
  return { timers, relay, fake };
}

describe("pairDevice (side A)", () => {
  beforeEach(() => FakeWebSocket.reset());

  it("pairs with the fake tray, derives the same PK and persists only after pair_result ok", async () => {
    const { relay, fake, timers } = await setup({ pairingCode: "K7M3-ABCD-EFGH" });
    const storage = createMemoryStorage();
    const steps: string[] = [];
    const record = await pairDevice(relay, "k7m3 abcd efgh", { timers, store: storage.pairings, onStep: (s) => steps.push(s) });
    expect(steps).toEqual(["joining", "pake1", "pake2", "pake3", "result"]);
    expect(record.device_id).toBe(fake.device.deviceId);
    expect(record.name).toBe("Office PC");
    expect(fake.pairedPK).not.toBeNull();
    expect(bytesToHex(record.pk)).toBe(bytesToHex(fake.pairedPK!));
    expect(bytesToHex(record.pairing_id)).toBe(bytesToHex(pairingIdFromPK(fake.pairedPK!)));
    expect(await storage.pairings.get(record.device_id)).toMatchObject({ name: "Office PC" });
    const frames = fake.ws.frames();
    expect(frames.find((f) => f.type === "pair_join")).toEqual({ type: "pair_join", claim: "K7M3" });
    const msgs = frames.filter((f) => f.type === "pair_msg").map((f) => (f.payload as { t: string }).t);
    expect(msgs).toEqual(["pake1", "pake3"]);
    // The secret never appears on the wire.
    expect(JSON.stringify(frames)).not.toContain("ABCDEFGH");
    // And the resulting pairing opens a real session with the fake device.
    const session = new DeviceSession(relay, { deviceId: record.device_id, pairing: record, timers, log: () => undefined });
    await expect(session.open()).resolves.toMatchObject({ type: "device_info" });
    session.dispose();
  });

  it("fails with E_BAD_MAC when the tray has a different code, without persisting", async () => {
    const { relay, timers } = await setup({ pairingCode: "K7M3-ABCD-EFGH" });
    const storage = createMemoryStorage();
    await expect(pairDevice(relay, "K7M3-ABCD-EFGX", { timers, store: storage.pairings })).rejects.toMatchObject({ code: "E_BAD_MAC" });
    expect(await storage.pairings.list()).toEqual([]);
  });

  it("rejects malformed codes locally and relays E_PAIR_* errors", async () => {
    const { relay, timers } = await setup({ pairingCode: "K7M3-ABCD-EFGH" });
    await expect(pairDevice(relay, "K7M3-ABCD", { timers })).rejects.toMatchObject({ code: "E_CODE_INVALID" });
    await expect(pairDevice(relay, "K7M3-ABCD-EFGU", { timers })).rejects.toMatchObject({ code: "E_CODE_INVALID" });
    await expect(pairDevice(relay, "ZZZZ-ABCD-EFGH", { timers })).rejects.toMatchObject({ code: "E_PAIR_NOT_FOUND" });
  });

  it("times out after 60 s without pair_joined and fails on pair_result ok:false", async () => {
    const { relay, timers, fake } = await setup({ pairingCode: "K7M3-ABCD-EFGH" });
    fake.ws.onmessage = null; // relay goes mute
    const p = pairDevice(relay, "K7M3-ABCD-EFGH", { timers });
    p.catch(() => undefined);
    await timers.advance(60_000);
    await expect(p).rejects.toMatchObject({ code: "E_TIMEOUT" });

    const s2 = await setup({ pairingCode: "K7M3-ABCD-EFGH" });
    s2.fake.pairResultOk = false;
    await expect(pairDevice(s2.relay, "K7M3-ABCD-EFGH", { timers: s2.timers })).rejects.toBeInstanceOf(PairingError);
  });

  it("fails when the relay disconnects mid-flow", async () => {
    const { relay, timers, fake } = await setup({ pairingCode: "K7M3-ABCD-EFGH" });
    fake.ws.onmessage = null;
    const p = pairDevice(relay, "K7M3-ABCD-EFGH", { timers });
    p.catch(() => undefined);
    fake.ws.serverClose(4005, "bye");
    await expect(p).rejects.toMatchObject({ code: "E_DISCONNECTED" });
  });
});
