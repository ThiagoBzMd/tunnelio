// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/lib/api";
import { createMemoryStorage, type AppStorage } from "../src/lib/storage";
import { RelayClient } from "../src/relay/client";
import { pairingIdFromPK } from "../src/crypto/pairing";
import { randomBytes, utf8Decode } from "../src/crypto/bytes";
import { b64urlDecode, b64urlEncode } from "../src/crypto/b64url";
import { authKeyToPassword, deriveLoginKeys } from "../src/crypto/auth";
import { openPairings, openPreferences, sealPreferences } from "../src/crypto/sync";
import { unlockPairings } from "../src/stores/pairing-sync";
import {
  authStore,
  DEFAULT_FLAGS,
  pickFlags,
  chatStore,
  configureRuntime,
  devicesStore,
  getRuntime,
  decodePreferences,
  encodePreferences,
  forgetPreferencesSyncState,
  getSessionPairingsKey,
  hasSessionPairingsKey,
  loadAccount,
  historyStore,
  modelsStore,
  pullPairings,
  resetAllStores,
  sessionsStore,
  setSessionPairingsKey,
  pickSynced,
  pushPreferences,
  settingsStore,
  startApp,
  syncPreferences,
  wireStores,
} from "../src/stores";
import { createFakeServer } from "./helpers/fake-server";
import { FakeTimers } from "./helpers/fake-timers";
import { FakeWebSocket } from "./helpers/fake-ws";
import { DEVICE_ID, FakeRelay, TINY_JPEG_B64, type FakeRelayOptions } from "./helpers/fake-device";
import { totpCode } from "./helpers/totp";
import { ChatSendError, fitImagesToBudget, toWire } from "../src/stores/chat";
import { libraryStore } from "../src/stores/library";
import { activeSkills, composeSystem, newAgent, newSkill } from "../src/lib/agents";
import { composeContent } from "../src/lib/documents/format";
import type { FakeHistoryState } from "./helpers/fake-device";
import { selectSupportsVision, supportsVision } from "../src/stores/models";
import type { ChatRequest } from "../src/protocol/channel";

/** What the server stores for u@x.y / "password123": the derived auth key, never the password. */
let AUTH_PW = "";
const authKeyFor = async (email: string, password: string) => authKeyToPassword((await deriveLoginKeys(email, password)).authKey);
beforeAll(async () => {
  AUTH_PW = await authKeyFor("u@x.y", "password123");
}, 30_000);

interface Env {
  timers: FakeTimers;
  relay: RelayClient;
  storage: AppStorage;
  srv: ReturnType<typeof createFakeServer>;
  attachRelay(opts?: FakeRelayOptions): Promise<FakeRelay>;
  unwire(): void;
}

async function setup(): Promise<Env> {
  FakeWebSocket.reset();
  resetAllStores();
  setSessionPairingsKey(null);
  authStore.setState({ status: "unknown", me: null, busy: false, error: null, errorCode: null, pendingVerification: null, totpRequired: false, disconnected: false });
  settingsStore.getState().reset();
  forgetPreferencesSyncState();
  const timers = new FakeTimers();
  const srv = createFakeServer();
  const api = createApi({ fetch: srv.fetch, getCsrfToken: () => srv.cookies.get("csrftoken") ?? null });
  const storage = createMemoryStorage();
  const relay = new RelayClient({ url: "ws://t/ws/client", appVersion: "t", WebSocket: FakeWebSocket, timers, random: () => 0, log: () => undefined });
  configureRuntime({ api, storage, relay, timers, appVersion: "t" });
  const unwire = wireStores(relay);
  srv.state.users.set("u@x.y", { email: "u@x.y", password: AUTH_PW, created_at: "2026-10-08T00:00:00Z", active: true, totp: null, pendingTotp: null });
  srv.state.devices.set(DEVICE_ID, { id: DEVICE_ID, name: "Office PC", platform: "linux", tray_version: "0.1.0", created_at: "t", last_seen_at: null, online: true, owner: "u@x.y" });
  return {
    timers,
    relay,
    storage,
    srv,
    unwire,
    attachRelay: async (opts = {}) => {
      relay.connect();
      const fake = new FakeRelay(opts);
      fake.attach();
      await timers.flush();
      return fake;
    },
  };
}

async function signIn(password = "password123"): Promise<void> {
  await authStore.getState().bootstrap();
  expect(await authStore.getState().login("u@x.y", password)).toBe(true);
}

describe("stores", () => {
  let env: Env;
  beforeEach(async () => {
    env = await setup();
  });

  it("auth: one password → derived auth key on the wire; login, logout, delete account", async () => {
    expect(await authStore.getState().bootstrap()).toBe("anonymous");
    expect(await authStore.getState().login("u@x.y", "nope")).toBe(false);
    expect(authStore.getState().errorCode).toBe("E_AUTH");
    expect(await authStore.getState().login("u@x.y", "password123")).toBe(true);
    expect(authStore.getState().me).toMatchObject({ email: "u@x.y", totp_enabled: false });
    expect(env.relay.state).toBe("connecting");
    expect(hasSessionPairingsKey()).toBe(true);
    // The server only ever sees the 43-character auth key (V8), never the typed password.
    const login = env.srv.state.requests.filter((r) => r.path === "/api/auth/login").pop()!;
    expect((login.body as { password: string }).password).toBe(AUTH_PW);
    expect(AUTH_PW).toHaveLength(43);
    expect(JSON.stringify(env.srv.state.requests)).not.toContain("password123");
    chatStore.getState().create({ device_id: DEVICE_ID, model: "m" });
    expect(await env.storage.session.getPairingsKey()).not.toBeNull(); // remembered for reloads
    await authStore.getState().logout();
    expect(authStore.getState().status).toBe("anonymous");
    expect(env.relay.state).toBe("closed");
    expect(hasSessionPairingsKey()).toBe(false);
    expect(await env.storage.session.getPairingsKey()).toBeNull();
    expect(Object.keys(chatStore.getState().conversations)).toEqual([]);
    await signIn();
    expect(await authStore.getState().deleteAccount("wrong password!")).toBe(false);
    expect(await authStore.getState().deleteAccount("password123")).toBe(true);
    expect(authStore.getState().status).toBe("anonymous");
    expect(env.srv.state.users.has("u@x.y")).toBe(false);
    env.unwire();
  }, 60_000);

  it("sign-up: with e-mail on the server the mailed code confirms the account; without it the sign-up signs in", async () => {
    await authStore.getState().bootstrap();
    expect(await authStore.getState().register("new@x.y", "password123")).toBe("verify");
    expect(authStore.getState()).toMatchObject({ status: "anonymous", pendingVerification: "new@x.y" });
    expect(env.srv.state.users.get("new@x.y")).toMatchObject({ active: false, password: await authKeyFor("new@x.y", "password123") });
    // Signing in before confirming → E_EMAIL_UNVERIFIED → the verify screen.
    expect(await authStore.getState().login("new@x.y", "password123")).toBe(false);
    expect(authStore.getState().pendingVerification).toBe("new@x.y");
    expect(await authStore.getState().resendCode("new@x.y")).toBe(true);
    expect(env.srv.state.outbox.filter((m) => m.to === "new@x.y" && m.kind === "verify")).toHaveLength(2);
    const code = env.srv.state.outbox.at(-1)!.code;
    expect(await authStore.getState().verifyEmail("new@x.y", code === "000000" ? "000001" : "000000")).toBe(false);
    expect(authStore.getState().errorCode).toBe("E_BAD_CODE");
    expect(await authStore.getState().verifyEmail("new@x.y", `${code.slice(0, 3)} ${code.slice(3)}`)).toBe(true);
    expect(authStore.getState()).toMatchObject({ status: "authenticated", pendingVerification: null });
    expect(authStore.getState().me?.email).toBe("new@x.y");
    expect(hasSessionPairingsKey()).toBe(true); // the keys of the sign-in attempt in this tab were kept
    expect(env.srv.state.users.get("new@x.y")?.active).toBe(true);
    // A new sign-up on an existing active account is refused; an abandoned (inactive) one is replaced.
    expect(await authStore.getState().register("new@x.y", "password123")).toBe(false);
    expect(authStore.getState().errorCode).toBe("E_EXISTS");
    await authStore.getState().logout();
    env.srv.state.emailEnabled = false;
    expect(await authStore.getState().register("plain@x.y", "password123")).toBe("signed_in");
    expect(authStore.getState().me?.email).toBe("plain@x.y");
    env.unwire();
  }, 60_000);

  it("two-step sign-in: setup → enable with a code → login needs the code → disable with password + code", async () => {
    await signIn();
    const setup = await authStore.getState().totpSetup();
    expect(setup?.otpauth_url).toContain("otpauth://totp/");
    expect(await authStore.getState().totpEnable("000000")).toBe(false);
    expect(authStore.getState().errorCode).toBe("E_BAD_CODE");
    expect(await authStore.getState().totpEnable(totpCode(setup!.secret))).toBe(true);
    expect(authStore.getState().me?.totp_enabled).toBe(true);
    await authStore.getState().logout();
    await authStore.getState().bootstrap();
    expect(await authStore.getState().login("u@x.y", "password123")).toBe(false);
    expect(authStore.getState()).toMatchObject({ totpRequired: true, errorCode: "E_TOTP_REQUIRED", error: null });
    expect(await authStore.getState().login("u@x.y", "password123", undefined, "000000")).toBe(false);
    expect(authStore.getState()).toMatchObject({ totpRequired: true, errorCode: "E_TOTP_INVALID" });
    expect(await authStore.getState().login("u@x.y", "password123", undefined, totpCode(setup!.secret))).toBe(true);
    expect(authStore.getState().totpRequired).toBe(false);
    expect(await authStore.getState().totpDisable("wrong password!", totpCode(setup!.secret))).toBe(false);
    expect(await authStore.getState().totpDisable("password123", "000000")).toBe(false);
    expect(await authStore.getState().totpDisable("password123", totpCode(setup!.secret))).toBe(true);
    expect(authStore.getState().me?.totp_enabled).toBe(false);
    env.unwire();
  }, 60_000);

  it("password change: re-keyed pairings, every device disconnected (server + local), the notice is set", async () => {
    await signIn();
    const pk = randomBytes(32);
    await env.storage.pairings.put({ device_id: DEVICE_ID, pairing_id: pairingIdFromPK(pk), pk, name: "Office PC", created_at: "2026-10-09T00:00:00Z" });
    await devicesStore.getState().refresh();
    expect(devicesStore.getState().devices[DEVICE_ID]?.paired).toBe(true);
    expect(env.srv.state.pairings.has("u@x.y")).toBe(true);
    const keyBefore = getSessionPairingsKey()!;
    expect(await authStore.getState().changePassword("wrong password!", "password789abc")).toBe(false);
    expect(await authStore.getState().changePassword("password123", "password789abc")).toBe(true);
    expect(env.srv.state.users.get("u@x.y")?.password).toBe(await authKeyFor("u@x.y", "password789abc"));
    expect(getSessionPairingsKey()).not.toEqual(keyBefore);
    expect(authStore.getState().disconnected).toBe(true);
    expect(await env.storage.pairings.list()).toEqual([]);
    expect(devicesStore.getState().order).toEqual([]);
    expect(env.srv.state.devices.size).toBe(0);
    expect(env.srv.state.pairings.has("u@x.y")).toBe(false);
    expect(authStore.getState().status).toBe("authenticated"); // this session stays
    authStore.getState().clearDisconnected();
    expect(authStore.getState().disconnected).toBe(false);
    env.unwire();
  }, 60_000);

  it("forgot password: e-mail code → new password (as its derived auth key) → everything out → sign in, no devices left", async () => {
    await signIn();
    const pk = randomBytes(32);
    await env.storage.pairings.put({ device_id: DEVICE_ID, pairing_id: pairingIdFromPK(pk), pk, name: "Office PC", created_at: "2026-10-09T00:00:00Z" });
    await devicesStore.getState().refresh();
    await authStore.getState().logout();
    expect(await authStore.getState().requestPasswordReset("u@x.y")).toBe(true);
    expect(await authStore.getState().requestPasswordReset("nobody@x.y")).toBe(true); // no enumeration
    expect(env.srv.state.outbox.map((m) => m.to)).toEqual(["u@x.y"]);
    const first = env.srv.state.outbox[0]!.code;
    expect(await authStore.getState().requestPasswordReset("u@x.y")).toBe(true); // a new code replaces the previous one
    const code = env.srv.state.outbox.at(-1)!.code;
    const wrong = (c: string) => (c === "000000" ? "000001" : "000000");
    if (first !== code) {
      expect(await authStore.getState().confirmPasswordReset("u@x.y", first, "brand new password")).toBe(false);
      expect(authStore.getState().errorCode).toBe("E_BAD_CODE");
    }
    expect(await authStore.getState().confirmPasswordReset("u@x.y", wrong(code), "brand new password")).toBe(false);
    expect(authStore.getState().errorCode).toBe("E_BAD_CODE");
    expect(authStore.getState().error).toContain("Wrong or expired code");
    expect(await authStore.getState().confirmPasswordReset(" u@x.y ", `${code.slice(0, 3)} ${code.slice(3)}`, "brand new password")).toBe(true);
    const confirm = env.srv.state.requests.filter((r) => r.path === "/api/auth/password-reset/confirm").at(-1)!;
    expect(confirm.body).toEqual({ email: "u@x.y", code, new_password: await authKeyFor("u@x.y", "brand new password") });
    expect(JSON.stringify(env.srv.state.requests)).not.toContain("brand new password");
    // Single-use code, old password dead, devices and the synced pairings gone server-side …
    expect(await authStore.getState().confirmPasswordReset("u@x.y", code, "another new password")).toBe(false);
    expect(await authStore.getState().login("u@x.y", "password123")).toBe(false);
    expect(env.srv.state.devices.size).toBe(0);
    expect(env.srv.state.pairings.has("u@x.y")).toBe(false);
    expect(await authStore.getState().login("u@x.y", "brand new password")).toBe(true);
    // … and the stale local pairing goes with the first device list.
    expect(await devicesStore.getState().refresh()).toEqual([]);
    expect(await env.storage.pairings.list()).toEqual([]);
    // Five wrong attempts burn a code, even the right one afterwards; expired codes fail too.
    await authStore.getState().requestPasswordReset("u@x.y");
    const burned = env.srv.state.outbox.at(-1)!.code;
    for (let i = 0; i < 5; i++) expect(await authStore.getState().confirmPasswordReset("u@x.y", wrong(burned), "third password here")).toBe(false);
    expect(await authStore.getState().confirmPasswordReset("u@x.y", burned, "third password here")).toBe(false);
    await authStore.getState().requestPasswordReset("u@x.y");
    const late = env.srv.state.outbox.at(-1)!.code;
    const realNow = env.srv.state.now;
    env.srv.state.now = () => realNow() + 16 * 60_000;
    expect(await authStore.getState().confirmPasswordReset("u@x.y", late, "third password here")).toBe(false);
    env.srv.state.now = realNow;
    expect(authStore.getState().errorCode).toBe("E_BAD_CODE");
    // Without e-mail on the server the request is refused (the UI hides the link then).
    env.srv.state.emailEnabled = false;
    expect(await authStore.getState().requestPasswordReset("u@x.y")).toBe(false);
    expect(authStore.getState().errorCode).toBe("E_EMAIL_DISABLED");
    env.unwire();
  }, 90_000);

  it("devices: REST list merged with pairings and live presence", async () => {
    await signIn();
    await env.storage.pairings.put({ device_id: DEVICE_ID, pairing_id: randomBytes(16), pk: randomBytes(32), name: "Office PC", created_at: "t" });
    const list = await devicesStore.getState().refresh();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: DEVICE_ID, paired: true, online: true });
    const fake = await env.attachRelay({ deviceOnline: false });
    expect(devicesStore.getState().devices[DEVICE_ID]?.online).toBe(false);
    fake.setDeviceOnline(true);
    expect(devicesStore.getState().devices[DEVICE_ID]?.online).toBe(true);
    expect(await devicesStore.getState().rename(DEVICE_ID, "Desk")).toBe(true);
    expect(devicesStore.getState().devices[DEVICE_ID]?.name).toBe("Desk");
    await devicesStore.getState().forget(DEVICE_ID);
    expect(devicesStore.getState().devices[DEVICE_ID]?.paired).toBe(false);
    expect(await env.storage.pairings.get(DEVICE_ID)).toBeNull();
    expect(await devicesStore.getState().remove(DEVICE_ID)).toBe(true);
    expect(devicesStore.getState().order).toEqual([]);
    env.unwire();
  });

  it("sessions/models/chat/history: end-to-end through the fake device", async () => {
    await signIn();
    const fake = await env.attachRelay();
    await expect(sessionsStore.getState().open(DEVICE_ID)).rejects.toMatchObject({ code: "E_UNKNOWN_PAIRING" });
    expect(sessionsStore.getState().sessions[DEVICE_ID]?.status).toBe("needs-pairing");
    const pk = randomBytes(32);
    fake.device.addPairing(pk);
    await env.storage.pairings.put({ device_id: DEVICE_ID, pairing_id: pairingIdFromPK(pk), pk, name: "Office PC", created_at: "t" });
    sessionsStore.getState().close(DEVICE_ID);
    const session = await sessionsStore.getState().open(DEVICE_ID);
    expect(session.status).toBe("ready");
    expect(sessionsStore.getState().sessions[DEVICE_ID]).toMatchObject({ status: "ready", device_info: { tray_version: "0.1.0-test", capabilities: ["history", "think", "images", "history_clear", "agents"], limits: { max_images_per_message: 4 } } });

    const models = await modelsStore.getState().list(DEVICE_ID);
    expect(models.map((m) => m.name)).toEqual(["llama3.2:3b"]);
    expect(await modelsStore.getState().listRunning(DEVICE_ID)).toEqual([]);
    expect(supportsVision(DEVICE_ID, "llama3.2:3b")).toBeNull(); // not shown yet
    expect((await modelsStore.getState().show(DEVICE_ID, "llama3.2:3b"))?.context_length).toBe(8192);
    expect(supportsVision(DEVICE_ID, "llama3.2:3b")).toBe(false);
    await modelsStore.getState().show(DEVICE_ID, "llava:7b");
    expect(selectSupportsVision(modelsStore.getState(), DEVICE_ID, "llava:7b")).toBe(true);
    expect(supportsVision("other-device", "llava:7b")).toBeNull();
    expect(await modelsStore.getState().show(DEVICE_ID, "BAD NAME")).toBeNull();
    expect(await modelsStore.getState().pull(DEVICE_ID, "llama3.2")).toBe(false); // tag required
    expect(await modelsStore.getState().pull(DEVICE_ID, "llama3.2:1b")).toBe(true);
    expect(modelsStore.getState().byDevice[DEVICE_ID]?.pulls["llama3.2:1b"]).toMatchObject({ done: true, error: null, completed: 50 });
    // One download at a time per computer: the next one waits in line, the same name joins the
    // first, and one canceled while it waits never reaches the computer.
    const before = fake.device.received.filter((r) => r.type === "pull_model").length;
    const first = modelsStore.getState().pull(DEVICE_ID, "qwen3:4b");
    expect(modelsStore.getState().pull(DEVICE_ID, "qwen3:4b")).toBe(first);
    const second = modelsStore.getState().pull(DEVICE_ID, "gemma3:1b");
    expect(modelsStore.getState().byDevice[DEVICE_ID]?.pulls["gemma3:1b"]).toMatchObject({ queued: true, status: "queued", done: false });
    const third = modelsStore.getState().pull(DEVICE_ID, "phi4:14b");
    await modelsStore.getState().cancelPull(DEVICE_ID, "phi4:14b");
    expect(await Promise.all([first, second, third])).toEqual([true, true, false]);
    expect(modelsStore.getState().byDevice[DEVICE_ID]?.pulls["phi4:14b"]).toMatchObject({ done: true, canceled: true, error: null });
    expect(
      fake.device.received
        .filter((r) => r.type === "pull_model")
        .slice(before)
        .map((r) => (r.type === "pull_model" ? r.name : "")),
    ).toEqual(["qwen3:4b", "gemma3:1b"]);
    modelsStore.getState().dismissPull(DEVICE_ID, "phi4:14b");
    expect(modelsStore.getState().byDevice[DEVICE_ID]?.pulls["phi4:14b"]).toBeUndefined();
    expect(await modelsStore.getState().remove(DEVICE_ID, "llama3.2:3b")).toBe(true);
    expect(modelsStore.getState().byDevice[DEVICE_ID]?.models).toEqual([]);

    const conv = chatStore.getState().create({ device_id: DEVICE_ID, model: "llama3.2:3b" });
    const seen: string[] = [];
    const unsub = chatStore.subscribe((s) => {
      const c = s.conversations[conv.id];
      const a = c?.messages.find((m) => m.role === "assistant");
      if (a && seen[seen.length - 1] !== a.content) seen.push(a.content);
    });
    const done = await chatStore.getState().send(conv.id, "  Oi  ");
    unsub();
    expect(done?.done_reason).toBe("stop");
    const after = chatStore.getState().conversations[conv.id]!;
    expect(after.title).toBe("Oi");
    expect(after.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(after.messages[1]).toMatchObject({ content: "Hello world", id: expect.stringMatching(/^m-/), stats: { eval_count: 3 } });
    expect(after.messages[1]?.streaming).toBeUndefined();
    expect(seen).toEqual(["", "Hello", "Hello ", "Hello world"]);
    const req = fake.device.received.find((r) => r.type === "chat");
    expect(req).toMatchObject({ type: "chat", mode: "private", title: "Oi", messages: [{ role: "user", content: "Oi" }] });
    expect(chatStore.getState().streaming).toBeNull();
    // Second turn sends the full history.
    await chatStore.getState().send(conv.id, "Mais");
    const req2 = fake.device.received.filter((r) => r.type === "chat")[1];
    expect(req2).toMatchObject({ messages: [{ role: "user", content: "Oi" }, { role: "assistant", content: "Hello world" }, { role: "user", content: "Mais" }] });
    expect(req2 && "title" in req2).toBe(false);
    // Third turn: image only (empty text is allowed when images are attached); the fourth turn
    // re-sends the earlier image because Ollama is stateless.
    expect(await chatStore.getState().send(conv.id, "  ", { images: [TINY_JPEG_B64] })).toMatchObject({ done_reason: "stop" });
    const req3 = fake.device.received.filter((r) => r.type === "chat")[2];
    expect(req3?.messages.at(-1)).toEqual({ role: "user", content: "", images: [TINY_JPEG_B64] });
    expect(chatStore.getState().conversations[conv.id]?.messages[4]).toMatchObject({ role: "user", content: "", images: [TINY_JPEG_B64] });
    await chatStore.getState().send(conv.id, "What is it?");
    const req4 = fake.device.received.filter((r) => r.type === "chat")[3];
    expect(req4?.messages.map((m) => [m.role, m.images?.length ?? 0])).toEqual([["user", 0], ["assistant", 0], ["user", 0], ["assistant", 0], ["user", 1], ["assistant", 0], ["user", 0]]);
    await expect(chatStore.getState().send(conv.id, "x", { images: [TINY_JPEG_B64, TINY_JPEG_B64, TINY_JPEG_B64, TINY_JPEG_B64, TINY_JPEG_B64] })).rejects.toThrow(/at most 4/);
    await expect(chatStore.getState().send(conv.id, "x", { images: ["data:image/jpeg;base64,AAAA"] })).rejects.toThrow(/base64/);
    await expect(chatStore.getState().send(conv.id, "", { images: [] })).rejects.toThrow(/empty/);
    expect(fake.device.received.filter((r) => r.type === "chat")).toHaveLength(4);
    // An agent chain (rev. 1.9): the earlier agent answers first in an anonymous chat; the final request
    // carries that answer, to keep with the reply, and the final agent gets it in its system message.
    const lead = "aaaaaaaa-0000-4000-8000-0000000000c1";
    await chatStore.getState().send(conv.id, "Chained", { system: "Final agent.", agent_id: lead, chain: [{ agent_id: lead, name: "Drafter", model: "llama3.2:3b", system: "Draft it." }] });
    const [stepReq, finalReq] = fake.device.received.filter((r) => r.type === "chat").slice(4);
    expect(stepReq?.mode).toBe("incognito");
    expect(stepReq?.messages[0]).toEqual({ role: "system", content: "Draft it." });
    expect(stepReq && "chain" in stepReq).toBe(false);
    expect(stepReq?.messages.at(-1)).toEqual({ role: "user", content: "Chained" });
    expect(finalReq).toMatchObject({ mode: "private", agent_id: lead, chain: [{ agent_id: lead, name: "Drafter", model: "llama3.2:3b", content: "Hello world" }] });
    expect(finalReq?.messages[0]?.content).toMatch(/^Final agent\.\n\n# Agent chain[\s\S]*agent 2 of 2[\s\S]*<previous_answer agent="Drafter">\nHello world\n<\/previous_answer>$/);
    const chained = chatStore.getState().conversations[conv.id]?.messages.at(-1);
    expect(chained).toMatchObject({ role: "assistant", content: "Hello world", chain: [{ name: "Drafter", content: "Hello world" }] });
    expect(chained?.chainTotal).toBeUndefined();

    const list = await historyStore.getState().listPrivate(DEVICE_ID);
    expect(list.map((c) => c.id)).toEqual(["c1"]);
    const loaded = await historyStore.getState().getPrivate(DEVICE_ID, "c1");
    expect(loaded.messages.map((m) => m.content)).toEqual(["Oi", "Olá!"]);
    expect(loaded.messages[0]?.images).toEqual([TINY_JPEG_B64]);
    expect(loaded.messages[1]?.images).toBeUndefined();
    expect(chatStore.getState().conversations["c1"]?.device_id).toBe(DEVICE_ID);
    await chatStore.getState().rename("c1", "Renamed");
    expect(chatStore.getState().conversations["c1"]?.title).toBe("Renamed");
    expect(await historyStore.getState().deletePrivate(DEVICE_ID, "c1")).toBe(true);
    expect(chatStore.getState().conversations["c1"]).toBeUndefined();
    env.unwire();
  });

  it("chat: errors from the device mark the assistant message and abort is routed", async () => {
    await signIn();
    const fake = await env.attachRelay({
      device: {
        handle: async (req, reply) => {
          if (req.type === "chat") {
            await reply({ type: "error", id: req.id, code: "E_BUSY", message: "busy", retry_after_ms: 100 });
            return true;
          }
          if (req.type === "abort") {
            await reply({ type: "error", id: req.id, code: "E_NOT_FOUND" });
            return true;
          }
          return false;
        },
      },
    });
    const pk = randomBytes(32);
    fake.device.addPairing(pk);
    await env.storage.pairings.put({ device_id: DEVICE_ID, pairing_id: pairingIdFromPK(pk), pk, name: "PC", created_at: "t" });
    const conv = chatStore.getState().create({ device_id: DEVICE_ID, model: "m" });
    expect(await chatStore.getState().send(conv.id, "x")).toBeNull();
    const msg = chatStore.getState().conversations[conv.id]?.messages[1];
    expect(msg?.error).toContain("E_BUSY");
    expect(chatStore.getState().error).toContain("busy");
    await expect(chatStore.getState().send(conv.id, "")).rejects.toThrow(/empty/);
    // abort → E_NOT_FOUND (chat already finished / other session) is not an error for the UI.
    chatStore.getState().clearError();
    chatStore.setState({ streaming: { conversation_id: conv.id, request_id: "gone", message_id: "m", stalled: false } });
    await chatStore.getState().abort();
    expect(chatStore.getState().error).toBeNull();
    expect(fake.device.received.some((r) => r.type === "abort" && r.target_id === "gone")).toBe(true);
    chatStore.setState({ streaming: null });
    env.unwire();
  });

  it("unlock: signed in but without the pairings key (local data gone, cookie kept) → the password brings the pairings back", async () => {
    await signIn();
    const pk = randomBytes(32);
    await env.storage.pairings.put({ device_id: DEVICE_ID, pairing_id: pairingIdFromPK(pk), pk, name: "Office PC", created_at: "2026-10-09T00:00:00Z" });
    await devicesStore.getState().refresh(); // pushes the sealed blob
    expect(authStore.getState().pairingsKeyPresent).toBe(true);

    // Same cookie jar (the api client), empty local storage: a home-screen app on iOS, cleared site data.
    configureRuntime({ ...getRuntime(), storage: createMemoryStorage() });
    resetAllStores();
    setSessionPairingsKey(null); // a fresh context has no key in memory either
    expect(await authStore.getState().bootstrap()).toBe("authenticated");
    expect(authStore.getState().pairingsKeyPresent).toBe(false);
    expect((await devicesStore.getState().refresh())[0]?.paired).toBe(false);

    expect(await unlockPairings("not the password")).toBe("wrong_password");
    expect(authStore.getState().pairingsKeyPresent).toBe(false);
    expect(await unlockPairings("password123")).toBe("ok");
    expect(authStore.getState().pairingsKeyPresent).toBe(true);
    await devicesStore.getState().refresh();
    expect(devicesStore.getState().devices[DEVICE_ID]?.paired).toBe(true);
    expect((await getRuntime().storage.pairings.get(DEVICE_ID))?.pk).toEqual(pk);
  });

  it("preferences: sealed in the account; a new browser gets them; merge, sign-out, password change and reset", async () => {
    await signIn();
    await settingsStore.getState().update({ theme: "dark", display_name: "Ana", pinned_conversations: ["c1"], sidebar_pinned: false });
    expect(await syncPreferences()).toBe("pushed"); // nothing in the account yet: ours becomes it
    const sealed = env.srv.state.preferences.get("u@x.y")!;
    expect(sealed.ciphertext).not.toContain(b64urlEncode(new TextEncoder().encode("Ana")));
    const key = getSessionPairingsKey()!;
    const doc = decodePreferences(await openPreferences(key, b64urlDecode(sealed.ciphertext)))!;
    expect(doc.prefs).toMatchObject({ theme: "dark", display_name: "Ana", pinned_conversations: ["c1"] });
    expect(doc.prefs).not.toHaveProperty("sidebar_pinned"); // belongs to this browser
    await expect(openPairings(key, b64urlDecode(sealed.ciphertext))).rejects.toThrow(); // another AAD

    // Browser 2: empty storage, same account → the preferences arrive with the account.
    const browser1 = env.storage;
    configureRuntime({ ...getRuntime(), storage: createMemoryStorage() });
    resetAllStores();
    settingsStore.getState().reset();
    await settingsStore.getState().load();
    await signIn();
    await loadAccount();
    expect(settingsStore.getState().settings).toMatchObject({ theme: "dark", display_name: "Ana", pinned_conversations: ["c1"], sidebar_pinned: true });

    // Another browser changed the theme meanwhile; this one changes the language: both survive.
    const other = { ...pickSynced(settingsStore.getState().settings), theme: "light" as const };
    env.srv.state.preferences.set("u@x.y", { timestamp: "2026-10-14T00:00:00Z", ciphertext: b64urlEncode(await sealPreferences(key, encodePreferences(other))) });
    await settingsStore.getState().update({ language: "pt-BR" });
    expect(await syncPreferences()).toBe("pulled");
    expect(settingsStore.getState().settings).toMatchObject({ theme: "light", language: "pt-BR", display_name: "Ana" });
    const merged = decodePreferences(await openPreferences(key, b64urlDecode(env.srv.state.preferences.get("u@x.y")!.ciphertext)))!;
    expect(merged.prefs).toMatchObject({ theme: "light", language: "pt-BR" });

    // Password change: sealed again with the new key; the old key no longer opens it.
    expect(await authStore.getState().changePassword("password123", "a new password 42")).toBe(true);
    await pushPreferences();
    const newKey = getSessionPairingsKey()!;
    const resealed = b64urlDecode(env.srv.state.preferences.get("u@x.y")!.ciphertext);
    expect(decodePreferences(await openPreferences(newKey, resealed))!.prefs).toMatchObject({ display_name: "Ana" });
    await expect(openPreferences(key, resealed)).rejects.toThrow();

    // Sign-out: the person's preferences leave this browser; the browser's own ones stay.
    await settingsStore.getState().update({ sidebar_pinned: false });
    await authStore.getState().logout();
    expect(settingsStore.getState().settings).toMatchObject({ theme: "system", language: null, display_name: null, pinned_conversations: [], sidebar_pinned: false });

    // Forgotten password: the server drops the blob (nobody can open it); after signing in, ours is pushed.
    configureRuntime({ ...getRuntime(), storage: browser1 });
    env.srv.state.emailEnabled = true;
    expect(await authStore.getState().requestPasswordReset("u@x.y")).toBe(true);
    expect(await authStore.getState().confirmPasswordReset("u@x.y", env.srv.state.outbox.at(-1)!.code, "brand new password")).toBe(true);
    expect(env.srv.state.preferences.has("u@x.y")).toBe(false);
    expect(await authStore.getState().login("u@x.y", "brand new password")).toBe(true);
    await settingsStore.getState().update({ display_name: "Bia" });
    expect(await syncPreferences()).toBe("pushed");
    expect(env.srv.state.preferences.has("u@x.y")).toBe(true);
  });

  it("preferences: a change still waiting when the page goes away is pushed by the next start; one made during a sync is kept", async () => {
    await signIn();
    await settingsStore.getState().load();
    expect(await syncPreferences()).toBe("pushed");
    const key = getSessionPairingsKey()!;
    const inAccount = async () =>
      decodePreferences(await openPreferences(key, b64urlDecode(env.srv.state.preferences.get("u@x.y")!.ciphertext)))!.prefs;

    // The name changes and the page reloads before the push timer fires: nothing reached the account …
    await settingsStore.getState().update({ display_name: "Ana" });
    expect(await env.storage.settings.get("preferences.pending")).toEqual(["display_name"]);
    forgetPreferencesSyncState();
    settingsStore.getState().reset();
    await settingsStore.getState().load();
    expect((await inAccount()).display_name).toBeNull();
    // … the next start pushes it instead of taking the account's older value.
    await loadAccount();
    expect(settingsStore.getState().settings.display_name).toBe("Ana");
    expect((await inAccount()).display_name).toBe("Ana");
    expect(await env.storage.settings.get("preferences.pending")).toBeUndefined();

    // A change made while a sync is pushing is kept here and goes with the next push.
    const api = getRuntime().api;
    const put = api.putPreferences.bind(api);
    let once = true;
    api.putPreferences = async (body) => {
      await put(body);
      if (once) {
        once = false;
        await settingsStore.getState().update({ theme: "dark" });
      }
    };
    try {
      await settingsStore.getState().update({ language: "pt-BR" });
      expect(await syncPreferences()).toBe("pulled");
      expect(settingsStore.getState().settings.theme).toBe("dark");
      expect(await syncPreferences()).toBe("pulled");
      expect(settingsStore.getState().settings).toMatchObject({ theme: "dark", language: "pt-BR" });
      expect(await inAccount()).toMatchObject({ theme: "dark", language: "pt-BR", display_name: "Ana" });
    } finally {
      api.putPreferences = put;
    }
  });

  it("pairing sync: pairings travel sealed with the pairings key; a second browser is paired without a code", async () => {
    await signIn();
    const pk = randomBytes(32);
    await env.storage.pairings.put({ device_id: DEVICE_ID, pairing_id: pairingIdFromPK(pk), pk, name: "Office PC", created_at: "2026-10-09T00:00:00Z" });
    await devicesStore.getState().refresh();
    expect(devicesStore.getState().syncError).toBeNull();
    const blob = env.srv.state.pairings.get("u@x.y")!;
    expect(blob.timestamp).toMatch(/^\d{4}-/);
    expect(blob.ciphertext).not.toContain(b64urlEncode(pk));
    const key = getSessionPairingsKey()!;
    const plaintext = JSON.parse(utf8Decode(await openPairings(key, b64urlDecode(blob.ciphertext)))) as unknown;
    expect(plaintext).toEqual({ version: 1, pairings: [{ device_id: DEVICE_ID, pairing_id: b64urlEncode(pairingIdFromPK(pk)), pk: b64urlEncode(pk), name: "Office PC", created_at: "2026-10-09T00:00:00Z" }] });

    // Browser 2: empty storage, same account → the device is paired after refresh, no code typed.
    const browser1 = env.storage;
    const browser2 = createMemoryStorage();
    configureRuntime({ ...getRuntime(), storage: browser2 });
    resetAllStores();
    await signIn();
    const list = await devicesStore.getState().refresh();
    expect(list).toEqual([expect.objectContaining({ id: DEVICE_ID, paired: true })]);
    expect((await browser2.pairings.get(DEVICE_ID))?.pk).toEqual(pk);
    const fake = await env.attachRelay();
    fake.device.addPairing(pk);
    expect((await sessionsStore.getState().open(DEVICE_ID)).status).toBe("ready");

    // Forget on browser 2 removes it from the synced set; a newer pairing wins on the next merge.
    await devicesStore.getState().forget(DEVICE_ID);
    expect(await pullPairings()).toEqual({ records: [], stale: false });
    expect(devicesStore.getState().devices[DEVICE_ID]?.paired).toBe(false);
    const pk2 = randomBytes(32);
    await browser2.pairings.put({ device_id: DEVICE_ID, pairing_id: pairingIdFromPK(pk2), pk: pk2, name: "Office PC", created_at: "2026-10-09T01:00:00Z" });
    await devicesStore.getState().sync();
    expect(devicesStore.getState().devices[DEVICE_ID]?.paired).toBe(true);
    configureRuntime({ ...getRuntime(), storage: browser1 });
    await devicesStore.getState().refresh();
    expect((await browser1.pairings.get(DEVICE_ID))?.pk).toEqual(pk2);

    // A blob sealed under another key (previous password) counts as empty and is replaced by the local set.
    setSessionPairingsKey(randomBytes(32));
    expect(await pullPairings()).toEqual({ records: [], stale: true });
    await devicesStore.getState().refresh();
    expect(await pullPairings()).toMatchObject({ records: [expect.objectContaining({ device_id: DEVICE_ID })], stale: false });

    // A device removed from the account is dropped from the synced set and from local storage.
    env.srv.state.devices.delete(DEVICE_ID);
    await devicesStore.getState().refresh();
    expect(await pullPairings()).toEqual({ records: [], stale: false });
    expect(await browser1.pairings.get(DEVICE_ID)).toBeNull();
    // A reload loses the in-memory key; bootstrap takes it back from storage, so the sync keeps going.
    setSessionPairingsKey(null);
    expect(await authStore.getState().bootstrap()).toBe("authenticated");
    expect(hasSessionPairingsKey()).toBe(true);
    // Without any key (storage cleared too) the sync is a silent no-op.
    setSessionPairingsKey(null);
    await browser1.session.clearPairingsKey();
    await devicesStore.getState().refresh();
    expect(devicesStore.getState().syncError).toBeNull();
    env.unwire();
  }, 60_000);

  it("chat: model memory → num_ctx on every send; too long / over 8 MiB refused before anything is appended; titles from the prompt", async () => {
    await signIn();
    const fake = await env.attachRelay();
    const pk = randomBytes(32);
    fake.device.addPairing(pk);
    await env.storage.pairings.put({ device_id: DEVICE_ID, pairing_id: pairingIdFromPK(pk), pk, name: "PC", created_at: "t" });
    expect((await modelsStore.getState().show(DEVICE_ID, "llama3.2:3b"))?.context_length).toBe(8192);
    const chats = () => fake.device.received.filter((r) => r.type === "chat");

    // Documents lead the message; the title comes from the typed prompt (or the first document's name).
    const doc = { name: "contrato.pdf", kind: "pdf" as const, meta: { pages: 2 }, text: "x".repeat(20_000) };
    const conv = chatStore.getState().create({ device_id: DEVICE_ID, model: "llama3.2:3b" });
    await chatStore.getState().send(conv.id, composeContent([doc], "Resuma isto"));
    expect(chatStore.getState().conversations[conv.id]?.title).toBe("Resuma isto");
    // ceil(20 0xx / 3.5) + 2048 > 4096 → num_ctx: the next power of two, capped at the model's 8192.
    expect(chats()[0]).toMatchObject({ title: "Resuma isto", options: { num_ctx: 8192 } });
    // A small conversation keeps the default (no options at all).
    const small = chatStore.getState().create({ device_id: DEVICE_ID, model: "llama3.2:3b" });
    await chatStore.getState().send(small.id, "oi");
    expect(chats()[1]?.options).toBeUndefined();
    await chatStore.getState().send(small.id, "y".repeat(10_000));
    expect(chats()[2]?.options).toEqual({ num_ctx: 8192 }); // recomputed on every send: ceil(10 0xx/3.5)+2048 → 8192 (doubling)
    const docOnly = chatStore.getState().create({ device_id: DEVICE_ID, model: "llama3.2:3b" });
    await chatStore.getState().send(docOnly.id, composeContent([{ ...doc, text: "short" }], ""));
    expect(chatStore.getState().conversations[docOnly.id]?.title).toBe("contrato.pdf");

    // Over the model's memory: refused, nothing appended, nothing sent.
    const before = chatStore.getState().conversations[conv.id]!.messages.length;
    await expect(chatStore.getState().send(conv.id, "z".repeat(30_000))).rejects.toMatchObject({ code: "E_TOO_LONG" });
    expect(chatStore.getState().conversations[conv.id]!.messages).toHaveLength(before);
    expect(chats()).toHaveLength(4);
    // Unknown maximum (model never shown): no num_ctx, never "too long" — but the 8 MiB cap holds.
    const other = chatStore.getState().create({ device_id: DEVICE_ID, model: "unshown:1b" });
    await chatStore.getState().send(other.id, "w".repeat(20_000));
    expect(chats()[4]?.options).toBeUndefined();
    // The model is loaded (Ollama's own choice): a conversation that fits keeps that context (no
    // reload, nothing smaller); one that does not fit doubles, up to the model's max (8k here).
    await modelsStore.getState().show(DEVICE_ID, "llava:7b");
    fake.device.running = [{ name: "llava:7b", size: 1, size_vram: 1, expires_at: "t", context_length: 8192 }];
    const loaded = chatStore.getState().create({ device_id: DEVICE_ID, model: "llava:7b" });
    await chatStore.getState().send(loaded.id, "oi");
    expect(chats()[5]?.options).toEqual({ num_ctx: 8192 });
    fake.device.running = [{ name: "llava:7b", size: 1, size_vram: 1, expires_at: "t", context_length: 4096 }];
    await chatStore.getState().send(loaded.id, "u".repeat(20_000));
    expect(chats()[6]?.options).toEqual({ num_ctx: 8192 });
    fake.device.running = [];
    const err = await chatStore.getState().send(other.id, "v".repeat(9 * 1024 * 1024)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatSendError);
    expect(err).toMatchObject({ code: "E_TOO_LARGE" });
    expect(chatStore.getState().conversations[other.id]!.messages).toHaveLength(2);
    env.unwire();
  }, 60_000);

  it("downloads: a browser that comes back joins the download the computer is still doing", async () => {
    await signIn();
    const fake = await env.attachRelay({ device: { deviceInfo: { pull: { name: "llama3.2:1b" } } } });
    const pk = randomBytes(32);
    fake.device.addPairing(pk);
    await env.storage.pairings.put({ device_id: DEVICE_ID, pairing_id: pairingIdFromPK(pk), pk, name: "PC", created_at: "t" });
    await sessionsStore.getState().open(DEVICE_ID);
    await vi.waitFor(() => expect(modelsStore.getState().byDevice[DEVICE_ID]?.pulls["llama3.2:1b"]).toMatchObject({ done: true, error: null }));
    expect(fake.device.received.filter((r) => r.type === "pull_model").map((r) => (r.type === "pull_model" ? r.name : ""))).toEqual(["llama3.2:1b"]);
    env.unwire();
  });

  it("history: totals and delete-all on a current tray; an older tray says nothing and has no delete-all", async () => {
    await signIn();
    const state: FakeHistoryState = { conversations: 45, bytes: 120 * 1024 * 1024, cleared: false };
    const fake = await env.attachRelay({ device: { history: state } });
    const pk = randomBytes(32);
    fake.device.addPairing(pk);
    await env.storage.pairings.put({ device_id: DEVICE_ID, pairing_id: pairingIdFromPK(pk), pk, name: "PC", created_at: "t" });
    expect(await historyStore.getState().loadTotals(DEVICE_ID)).toMatchObject({ conversations: 45, bytes: 120 * 1024 * 1024, loading: false, error: null });
    expect(fake.device.received.find((r) => r.type === "history_list")).toMatchObject({ limit: 1 });
    expect(sessionsStore.getState().sessions[DEVICE_ID]?.device_info?.capabilities).toContain("history_clear");
    await historyStore.getState().listPrivate(DEVICE_ID);
    await historyStore.getState().getPrivate(DEVICE_ID, "c1");
    const open = chatStore.getState().create({ device_id: DEVICE_ID, model: "m" });
    chatStore.getState().select(open.id);
    expect(await historyStore.getState().clearAll(DEVICE_ID)).toBe(true);
    expect(fake.device.received.some((r) => r.type === "history_clear")).toBe(true);
    expect(historyStore.getState().privateByDevice[DEVICE_ID]?.items).toEqual([]);
    expect(chatStore.getState().conversations["c1"]).toBeUndefined();
    expect(chatStore.getState().conversations[open.id]).toBeUndefined();
    expect(chatStore.getState().activeId).toBeNull();
    expect(historyStore.getState().totals[DEVICE_ID]).toMatchObject({ conversations: 0, clearing: false });

    // Older tray: no totals in `history`, no "history_clear" capability.
    sessionsStore.getState().close(DEVICE_ID);
    env.relay.disconnect();
    historyStore.getState().reset();
    const old = await env.attachRelay({ device: { history: null, pairings: fake.device.pairings, deviceInfo: { capabilities: ["history", "think", "images"] } } });
    expect(old.device.deviceId).toBe(DEVICE_ID);
    expect(await historyStore.getState().loadTotals(DEVICE_ID)).toMatchObject({ conversations: null, bytes: null, error: null });
    expect(sessionsStore.getState().sessions[DEVICE_ID]?.device_info?.capabilities).not.toContain("history_clear");
    env.unwire();
  }, 60_000);

  it("agents and skills: kept on the computer; a chat with an agent sends its instructions and skills first and records it; an older computer has none", async () => {
    await signIn();
    const fake = await env.attachRelay();
    const pk = randomBytes(32);
    fake.device.addPairing(pk);
    await env.storage.pairings.put({ device_id: DEVICE_ID, pairing_id: pairingIdFromPK(pk), pk, name: "PC", created_at: "t" });
    const lib = libraryStore.getState();
    expect(await lib.load(DEVICE_ID)).toMatchObject({ supported: true, loaded: true, agents: [], skills: [] });

    const tone = await lib.saveSkill(DEVICE_ID, { ...newSkill(), name: " Tone ", description: "Letters to patients", category: "writing", instructions: "Warm and plain." });
    expect(tone).toMatchObject({ name: "Tone", category: "writing" });
    const writer = await lib.saveAgent(DEVICE_ID, { ...newAgent("llama3.2:3b"), name: "Writer", icon: "feather", instructions: "Answer in two words.", options: { temperature: 0.2 }, skills: "selected", skill_ids: [tone.id] });
    const extra = await lib.saveSkill(DEVICE_ID, { ...newSkill(), name: "Brevity", description: "Always", instructions: "Short." });
    expect(libraryStore.getState().byDevice[DEVICE_ID]?.skills.map((k) => k.name)).toEqual(["Brevity", "Tone"]);
    // A fresh read gives back what the computer keeps.
    libraryStore.getState().reset();
    const loaded = await libraryStore.getState().load(DEVICE_ID);
    expect(loaded.agents).toEqual([writer]);

    // The chat: system message first (instructions + the agent's skill + the chat's skill), the agent recorded.
    const skills = activeSkills(writer, loaded.skills, [extra.id]);
    const system = composeSystem(writer, skills);
    const conv = chatStore.getState().create({ device_id: DEVICE_ID, model: writer.model });
    await chatStore.getState().send(conv.id, "oi", { system, agent_id: writer.id, skill_ids: [extra.id], ...(writer.options ? { options: writer.options } : {}) });
    const sent = fake.device.received.filter((r) => r.type === "chat").at(-1) as ChatRequest;
    expect(sent.messages[0]).toEqual({ role: "system", content: system });
    expect(sent.messages[0]?.content).toContain("Answer in two words.");
    expect(sent.messages[0]?.content).toContain("## Tone");
    expect(sent.messages[0]?.content).toContain("## Brevity");
    expect(sent).toMatchObject({ agent_id: writer.id, skill_ids: [extra.id], options: { temperature: 0.2 } });
    expect(chatStore.getState().conversations[conv.id]).toMatchObject({ agent_id: writer.id, skill_ids: [extra.id] });
    expect(chatStore.getState().conversations[conv.id]?.messages.some((m) => m.role === "system")).toBe(false);
    // The next turn without the agent: nothing of it goes, and the conversation forgets it.
    await chatStore.getState().send(conv.id, "de novo");
    const second = fake.device.received.filter((r) => r.type === "chat").at(-1) as ChatRequest;
    expect(second.messages[0]?.role).toBe("user");
    expect(second.agent_id).toBeUndefined();
    expect(chatStore.getState().conversations[conv.id]).not.toHaveProperty("agent_id");

    // Deleting the skill takes it out of the agent; deleting the agent removes it.
    await lib.deleteSkill(DEVICE_ID, tone.id);
    expect(libraryStore.getState().byDevice[DEVICE_ID]?.agents[0]?.skill_ids).toEqual([]);
    await lib.deleteAgent(DEVICE_ID, writer.id);
    expect(libraryStore.getState().byDevice[DEVICE_ID]?.agents).toEqual([]);
    await expect(lib.deleteAgent(DEVICE_ID, writer.id)).rejects.toMatchObject({ code: "E_NOT_FOUND" });

    // An older computer: no "agents" capability, nothing asked, the screens say to update it.
    sessionsStore.getState().close(DEVICE_ID);
    env.relay.disconnect();
    libraryStore.getState().reset();
    const old = await env.attachRelay({ device: { pairings: fake.device.pairings, deviceInfo: { capabilities: ["history", "think", "images"] } } });
    expect(await libraryStore.getState().load(DEVICE_ID)).toMatchObject({ supported: false, loaded: true, agents: [] });
    expect(old.device.received.some((r) => r.type === "agent_list")).toBe(false);
    env.unwire();
  }, 60_000);

  it("chat wire helpers: images only on user turns, oldest images dropped first to fit the budget", () => {
    const now = "2026-10-09T00:00:00Z";
    const wire = toWire([
      { id: "1", role: "user", content: "a", created_at: now, images: [TINY_JPEG_B64] },
      { id: "2", role: "assistant", content: "b", created_at: now, images: [TINY_JPEG_B64] }, // never sent for assistants
      { id: "3", role: "assistant", content: "", created_at: now, error: "boom" }, // failed turns are skipped
      { id: "4", role: "user", content: "", created_at: now, images: [] },
      { id: "5", role: "user", content: "c", created_at: now, images: [TINY_JPEG_B64, TINY_JPEG_B64] },
    ]);
    expect(wire).toEqual([
      { role: "user", content: "a", images: [TINY_JPEG_B64] },
      { role: "assistant", content: "b" },
      { role: "user", content: "" },
      { role: "user", content: "c", images: [TINY_JPEG_B64, TINY_JPEG_B64] },
    ]);
    const req: ChatRequest = { type: "chat", id: "r", conversation_id: "c", mode: "private", model: "m", messages: structuredClone(wire) };
    const full = new TextEncoder().encode(JSON.stringify(req)).length;
    expect(fitImagesToBudget(req, full)).toBe(0);
    expect(fitImagesToBudget(req, full - 1)).toBe(1); // oldest user turn loses its image first
    expect(req.messages[0]).toEqual({ role: "user", content: "a" });
    expect(req.messages[3]?.images).toHaveLength(2);
    expect(fitImagesToBudget(req, 10)).toBe(0); // the newest message keeps its images; validateOutbound reports the overflow
    expect(req.messages[3]?.images).toHaveLength(2);
  });

  it("settings persist through storage; startApp bootstraps everything", async () => {
    expect(settingsStore.getState().settings).toMatchObject({ dictation: true, dictation_hint_seen: false });
    await settingsStore.getState().update({ theme: "dark", keep_alive: "5m", dictation: false, dictation_hint_seen: true });
    settingsStore.getState().reset();
    expect(await settingsStore.getState().load()).toMatchObject({ theme: "dark", keep_alive: "5m", think: false, dictation: false, dictation_hint_seen: true });
    await settingsStore.getState().update({ dictation: "yes" as never });
    expect(settingsStore.getState().settings.dictation).toBe(false);
    await settingsStore.getState().update({ theme: "weird" as never });
    expect(settingsStore.getState().settings.theme).toBe("dark");
    env.unwire();
    expect(await startApp()).toBe("anonymous");
    await authStore.getState().login("u@x.y", "password123");
    env.relay.disconnect();
    expect(await startApp()).toBe("authenticated");
    expect(devicesStore.getState().loaded).toBe(true);
    expect(env.relay.state).toBe("connecting");
  }, 30_000);
});

describe("server flags", () => {
  it("shows the bot check only with its site key, the https address of its script and the object it defines", () => {
    const script = "https://captcha.example/api.js";
    expect(pickFlags({ bot_check_site_key: "k", bot_check_script_url: script, bot_check_global: "captcha" }, DEFAULT_FLAGS)).toMatchObject({
      bot_check_site_key: "k",
      bot_check_script_url: script,
      bot_check_global: "captcha",
    });
    for (const half of [
      { bot_check_site_key: "k" },
      { bot_check_script_url: script },
      { bot_check_site_key: "k", bot_check_script_url: script },
      { bot_check_site_key: "k", bot_check_script_url: "http://captcha.example/api.js", bot_check_global: "captcha" },
      { bot_check_site_key: "k", bot_check_script_url: script, bot_check_global: "window.captcha" },
    ]) {
      expect(pickFlags(half, DEFAULT_FLAGS)).toMatchObject({ bot_check_site_key: null, bot_check_script_url: null, bot_check_global: null });
    }
  });
});
