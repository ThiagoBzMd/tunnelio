// @vitest-environment node
// End-to-end run of scripts/interop-client.ts (as a child process) against an in-process fake
// server: real HTTP (cookies + CSRF) and a real `ws` relay backed by FakeRelay/FakeDevice.

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeServer } from "./helpers/fake-server";
import { DEVICE_ID, FakeRelay } from "./helpers/fake-device";
import { totpCode } from "./helpers/totp";

const WEB_DIR = resolve(__dirname, "..");
const TSX = resolve(WEB_DIR, "node_modules/tsx/dist/cli.mjs");
const PAIRING_CODE = "K7M3-ABCD-EFGH";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

describe("interop CLI (end to end)", () => {
  let http: Server;
  let base = "";
  let stateDir = "";
  let stateFile = "";
  const fake = createFakeServer();
  const sharedPairings = new Map<string, Uint8Array>();

  beforeAll(async () => {
    http = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      fake.cookies.clear();
      for (const part of (req.headers.cookie ?? "").split(";")) {
        const eq = part.indexOf("=");
        if (eq > 0) fake.cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const init: RequestInit = { method: req.method ?? "GET", headers, credentials: "include" };
      if (body.length > 0) init.body = body;
      const response = await fake.fetch(req.url ?? "/", init);
      res.statusCode = response.status;
      response.headers.forEach((v, k) => {
        if (k.toLowerCase() !== "set-cookie") res.setHeader(k, v);
      });
      const setCookies = response.headers.getSetCookie();
      if (setCookies.length > 0) res.setHeader("Set-Cookie", setCookies);
      res.end(await response.text());
    });
    const wss = new WebSocketServer({
      server: http,
      path: "/ws/client",
      handleProtocols: (protocols) => (protocols.has("tunnelio.v1") ? "tunnelio.v1" : false),
    });
    wss.on("connection", (socket, req) => {
      const sid = /(?:^|;\s*)sessionid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
      if (!sid || !fake.state.sessions.has(sid)) {
        socket.close(4001, "unauthorized");
        return;
      }
      const relay = new FakeRelay({ pairingCode: PAIRING_CODE, device: { pairings: sharedPairings } });
      relay.sender = (frame) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
      };
      socket.on("message", (data) => {
        void relay.onClientFrame(JSON.parse(data.toString()) as Record<string, unknown>);
      });
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const addr = http.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    stateDir = mkdtempSync(join(tmpdir(), "tunnelio-cli-"));
    stateFile = join(stateDir, "state.json");
  });

  afterAll(async () => {
    await new Promise<void>((r) => http.close(() => r()));
    rmSync(stateDir, { recursive: true, force: true });
  });

  const runWith = (file: string, ...args: string[]): Promise<RunResult> =>
    new Promise((resolveRun) => {
      const child = spawn(process.execPath, [TSX, "scripts/interop-client.ts", ...args, "--server", base, "--state", file], {
        cwd: WEB_DIR,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
    });
  const run = (...args: string[]) => runWith(stateFile, ...args);

  it("signs up with the mailed code, pairs, chats, reads history, two-step sign-in, reset by code", async () => {
    let r = await run("me");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not logged in");

    // Sign-up needs the mailed code (e-mail on); the account is not signed in before that.
    r = await run("register", "--email", "cli@test.dev", "--password", "password123");
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("registered email=cli@test.dev verification_required=true");
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
    r = await run("login", "--email", "cli@test.dev", "--password", "password123");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("e-mail not confirmed");
    r = await run("resend-code", "--email", "cli@test.dev");
    expect(r.stdout).toContain("code requested");
    const verify = fake.state.outbox.filter((m) => m.kind === "verify").at(-1)!;
    r = await run("verify-email", "--email", "cli@test.dev", "--code", verify.code);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("verified email=cli@test.dev signed_in=true");

    // One password: the server stores the derived auth key; `auth-key` prints exactly that value.
    r = await run("auth-key", "--email", "cli@test.dev", "--password", "password123");
    expect(r.stderr).toBe("");
    const authKey = /^auth_key_b64url=([A-Za-z0-9_-]{43})\n$/.exec(r.stdout)?.[1];
    expect(authKey).toBeDefined();
    expect(fake.state.users.get("cli@test.dev")?.password).toBe(authKey);

    fake.state.devices.set(DEVICE_ID, { id: DEVICE_ID, name: "Office PC", platform: "linux", tray_version: "0.1.0", created_at: "t", last_seen_at: null, online: true, owner: "cli@test.dev" });

    r = await run("me");
    expect(r.stdout).toContain("email=cli@test.dev");
    expect(r.stdout).toContain("totp_enabled=false");

    r = await run("devices");
    expect(r.stdout).toContain(`device id=${DEVICE_ID} name="Office PC" platform=linux tray_version=0.1.0 online=true paired=false`);

    r = await run("models", "--device", DEVICE_ID);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("E_UNKNOWN_PAIRING");

    r = await run("pair", "--code", "k7m3-abcd-efgx");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("E_BAD_MAC");

    // The headless tray prints "PAIRING CODE: XXXX-XXXX-XXXX"; the whole line, the display form
    // and lowercase/no-dash input are all accepted. The pairing is synced right away: the pairings
    // key of the login lives in the state file.
    r = await run("login", "--email", "cli@test.dev", "--password", "password123");
    expect(r.stdout).toContain("logged in email=cli@test.dev totp_enabled=false");
    r = await run("pair", "--code", `PAIRING CODE: ${PAIRING_CODE}`);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain(`paired device_id=${DEVICE_ID} name="Office PC"`);
    expect(r.stdout).toContain("synced=true");
    expect(fake.state.pairings.get("cli@test.dev")?.ciphertext).toBeDefined();
    r = await run("pair", "--code", PAIRING_CODE.toLowerCase().replace(/-/g, ""));
    expect(r.stderr).toBe("");
    const state = readFileSync(stateFile, "utf8");
    expect(state).not.toContain("ABCDEFGH");
    expect(state).not.toContain("password123");
    expect(JSON.parse(state).pairings).toHaveLength(1);

    r = await run("pairings");
    expect(r.stdout).toContain(`pairing device_id=${DEVICE_ID}`);
    r = await run("devices");
    expect(r.stdout).toContain("paired=true");

    r = await run("models", "--device", DEVICE_ID);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("device_info tray_version=0.1.0-test platform=linux ollama=running/0.12.0 capabilities=history,think,images");
    expect(r.stdout).toContain("model name=llama3.2:3b size=2019393189 family=llama parameter_size=3.2B quantization=Q4_K_M running=false");

    r = await run("chat", "--device", DEVICE_ID, "--model", "llama3.2:3b", "--prompt", "Oi");
    expect(r.stderr).toBe("");
    expect(r.stdout.startsWith("Hello world\n")).toBe(true);
    expect(r.stdout).toMatch(/done reason=stop conversation_id=[0-9a-f-]{36} wall_ms=\d+ prompt_eval_count=2 eval_count=3 eval_ms=- total_ms=1 load_ms=- tokens_per_s=- message_id=m-/);

    r = await run("history", "--device", DEVICE_ID);
    expect(r.stdout).toContain('conversation id=c1 title="First" model=llama3.2:3b messages=2');
    r = await run("history", "--device", DEVICE_ID, "--get", "c1");
    expect(r.stdout).toContain('message role=assistant created_at=2026-10-01T00:00:30Z content="Olá!"');

    // A second state file (= another browser) is paired by the synced pairings at login.
    const stateFile2 = join(stateDir, "state2.json");
    r = await runWith(stateFile2, "login", "--email", "cli@test.dev", "--password", "password123");
    expect(r.stderr).toBe("");
    expect(JSON.parse(readFileSync(stateFile2, "utf8")).pairings).toHaveLength(1);

    // Two-step sign-in.
    r = await run("totp-setup");
    expect(r.stderr).toBe("");
    const secret = /totp_secret=([A-Z2-7]+)/.exec(r.stdout)?.[1];
    expect(secret).toBeDefined();
    r = await run("totp-enable", "--code", "000000");
    expect(r.code).toBe(1);
    r = await run("totp-enable", "--code", totpCode(secret!));
    expect(r.stdout).toContain("two-step sign-in enabled");
    r = await run("logout");
    r = await run("login", "--email", "cli@test.dev", "--password", "password123");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("add --totp CODE");
    r = await run("login", "--email", "cli@test.dev", "--password", "password123", "--totp", totpCode(secret!));
    expect(r.stdout).toContain("totp_enabled=true");
    r = await run("totp-disable", "--code", totpCode(secret!), "--password", "password123");
    expect(r.stdout).toContain("two-step sign-in disabled");

    // Forgot password: the reset disconnects every device; the next login finds none.
    r = await run("logout");
    r = await run("reset-request", "--email", "cli@test.dev");
    expect(r.stdout).toContain("reset code requested");
    const reset = fake.state.outbox.filter((m) => m.kind === "reset").at(-1)!;
    r = await run("reset-confirm", "--email", "cli@test.dev", "--code", reset.code, "--password", "brand new password");
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("password reset email=cli@test.dev");
    r = await run("login", "--email", "cli@test.dev", "--password", "brand new password");
    expect(r.stdout).toContain("logged in email=cli@test.dev");
    r = await run("devices");
    expect(r.stdout).toBe("no devices\n");
    expect(JSON.parse(readFileSync(stateFile, "utf8")).pairings).toHaveLength(0);

    r = await run("logout");
    expect(r.stdout).toBe("logged out\n");
    expect(JSON.parse(readFileSync(stateFile, "utf8")).pairings_key).toBeNull(); // gone with the session
    r = await run("me");
    expect(r.code).toBe(1);
  }, 240_000);
});
