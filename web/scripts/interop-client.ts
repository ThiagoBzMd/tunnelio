#!/usr/bin/env -S npx tsx
// Tunnelio interop CLI — drives the real web core (crypto, relay client, E2E session, stores)
// from Node against a running server, without a browser. Acceptance tool for end-to-end tests.
//
//   npx tsx scripts/interop-client.ts <command> [--server http://localhost:8080] [--state FILE] [--verbose]
//
// Commands:
//   register --email E --password P        create an account (with e-mail on the server: then verify-email)
//   verify-email --email E --code C        confirm the mailed sign-up code (signs in)
//   resend-code  --email E                 ask for a new sign-up code
//   login    --email E --password P [--totp CODE]   log in (cookies are kept in the state file)
//   auth-key --email E --password P        print the derived auth key (what the server stores as the password)
//   reset-request --email E                forgot password: the server e-mails a 6-digit code
//   reset-confirm --email E --code C --password P   set the new password (then: login; devices are disconnected)
//   totp-setup                             start two-step sign-in: prints the secret and the otpauth URL
//   totp-enable  --code C                  confirm two-step sign-in with a code from the app
//   totp-disable --code C --password P     turn two-step sign-in off
//   logout                                 log out
//   me                                     print the account
//   devices                                list devices (REST + local pairings; imports synced pairings)
//   pairings                               list pairings stored locally
//   pair     --code XXXX-XXXX-XXXX         SPAKE2 pairing; stores the pairing in the state file and syncs it
//   unpair   --device ID                   forget the local pairing for a device
//   models   --device ID                   list models (+ running) through the encrypted channel
//   chat     --device ID --model M --prompt "..." [--think]
//   history  --device ID [--get CONVERSATION_ID]   history (tray SQLite)
//   agents   --device ID [--model M] [--prompt "..."]   save a skill and an agent on the tray, list them,
//                                           chat with the agent when --prompt is given, then delete both
//
// One password: the typed password never reaches the server; register/login derive the auth key in
// the browser core. State file (default ./.tunnelio-cli.json, mode 0600): cookies, pairings (PK),
// the pairings key of the login, settings.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { WebSocket as WsWebSocket } from "ws";
import { authKeyToPassword, deriveLoginKeys } from "../src/crypto/auth";
import { b64urlDecode, b64urlEncode } from "../src/crypto/b64url";
import { createApi } from "../src/lib/api";
import { createMemoryStorage, type AppStorage, type PairingRecord } from "../src/lib/storage";
import { pairDevice } from "../src/pairing/flow";
import { realTimers } from "../src/protocol/timers";
import { RelayClient, type RelayLogger, type WebSocketCtor } from "../src/relay/client";
import { relayUrl } from "../src/relay/url";
import { activeSkills, composeSystem, newAgent, newSkill } from "../src/lib/agents";
import {
  authStore,
  chatStore,
  configureRuntime,
  devicesStore,
  hasSessionPairingsKey,
  historyStore,
  libraryStore,
  loadAccount,
  modelsStore,
  sessionsStore,
  wireStores,
} from "../src/stores";

const APP_VERSION = "interop-cli/0.1.0";

// ── args ─────────────────────────────────────────────────────────────────────

interface Args {
  command: string | null;
  opts: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { command: null, opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.opts[key] = next;
        i++;
      } else {
        out.opts[key] = true;
      }
    } else if (out.command === null) {
      out.command = a;
    }
  }
  return out;
}

function optString(args: Args, key: string): string | undefined {
  const v = args.opts[key];
  return typeof v === "string" ? v : undefined;
}

function requireOpt(args: Args, key: string): string {
  const v = optString(args, key);
  if (!v) throw new CliError(`missing --${key}`);
  return v;
}

class CliError extends Error {}

const out = (line: string): void => {
  process.stdout.write(line + "\n");
};
const err = (line: string): void => {
  process.stderr.write(line + "\n");
};

// ── state file ───────────────────────────────────────────────────────────────

interface StoredPairing {
  device_id: string;
  pairing_id: string;
  pk: string;
  name: string;
  created_at: string;
}
interface CliState {
  server: string;
  cookies: Record<string, string>;
  pairings: StoredPairing[];
  /** The pairings key derived at login (b64url), kept like the session cookie. */
  pairings_key: string | null;
  settings: Record<string, unknown>;
}

function loadState(file: string, server: string): CliState {
  const empty: CliState = { server, cookies: {}, pairings: [], pairings_key: null, settings: {} };
  if (!existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CliState>;
    return {
      server: parsed.server ?? server,
      cookies: parsed.cookies ?? {},
      pairings: parsed.pairings ?? [],
      pairings_key: parsed.pairings_key ?? null,
      settings: parsed.settings ?? {},
    };
  } catch {
    throw new CliError(`state file ${file} is not valid JSON`);
  }
}

function saveState(file: string, state: CliState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* non-POSIX */
  }
}

/** AppStorage backed by the state file: every mutation is written through immediately. */
async function createFileStorage(file: string, state: CliState): Promise<AppStorage> {
  const mem = createMemoryStorage();
  for (const p of state.pairings) {
    await mem.pairings.put({ device_id: p.device_id, pairing_id: b64urlDecode(p.pairing_id), pk: b64urlDecode(p.pk), name: p.name, created_at: p.created_at });
  }
  if (state.pairings_key) await mem.session.setPairingsKey(b64urlDecode(state.pairings_key));
  for (const [k, v] of Object.entries(state.settings)) await mem.settings.set(k, v);
  const sync = async (): Promise<void> => {
    const key = await mem.session.getPairingsKey();
    state.pairings_key = key ? b64urlEncode(key) : null;
    state.pairings = (await mem.pairings.list()).map((r) => ({
      device_id: r.device_id,
      pairing_id: b64urlEncode(r.pairing_id),
      pk: b64urlEncode(r.pk),
      name: r.name,
      created_at: r.created_at,
    }));
    state.settings = await mem.settings.all();
    saveState(file, state);
  };
  return {
    pairings: {
      list: () => mem.pairings.list(),
      get: (id) => mem.pairings.get(id),
      put: async (r: PairingRecord) => {
        await mem.pairings.put(r);
        await sync();
      },
      delete: async (id) => {
        await mem.pairings.delete(id);
        await sync();
      },
      clear: async () => {
        await mem.pairings.clear();
        await sync();
      },
    },
    session: {
      getPairingsKey: () => mem.session.getPairingsKey(),
      setPairingsKey: async (k) => {
        await mem.session.setPairingsKey(k);
        await sync();
      },
      clearPairingsKey: async () => {
        await mem.session.clearPairingsKey();
        await sync();
      },
    },
    settings: {
      get: (k) => mem.settings.get(k),
      set: async (k, v) => {
        await mem.settings.set(k, v);
        await sync();
      },
      delete: async (k) => {
        await mem.settings.delete(k);
        await sync();
      },
      all: () => mem.settings.all(),
    },
    close: () => mem.close(),
  };
}

// ── cookies ──────────────────────────────────────────────────────────────────

function cookieHeader(state: CliState): string {
  return Object.entries(state.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function captureCookies(state: CliState, res: Response, file: string): void {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (list.length === 0) return;
  for (const c of list) {
    const [pair, ...attrs] = c.split(";");
    const eq = (pair ?? "").indexOf("=");
    if (eq < 0) continue;
    const name = pair!.slice(0, eq).trim();
    const value = pair!.slice(eq + 1).trim();
    const maxAge = attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith("max-age="));
    const expired = maxAge !== undefined && Number(maxAge.slice(8)) <= 0;
    if (expired || value === "" || value === '""') delete state.cookies[name];
    else state.cookies[name] = value;
  }
  saveState(file, state);
}

// ── formatting ───────────────────────────────────────────────────────────────

const q = (s: string): string => JSON.stringify(s);
const ms = (ns: number | undefined): string => (ns === undefined ? "-" : (ns / 1e6).toFixed(0));

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const server = (optString(args, "server") ?? "http://localhost:8080").replace(/\/+$/, "");
  const stateFile = resolve(optString(args, "state") ?? ".tunnelio-cli.json");
  const verbose = args.opts.verbose === true;

  if (!args.command || args.command === "help" || args.opts.help === true) {
    const header = readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).slice(0, 30);
    out(header.map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }

  const state = loadState(stateFile, server);
  state.server = server;
  const storage = await createFileStorage(stateFile, state);
  const api = createApi({
    baseUrl: server,
    headers: () => ({ Cookie: cookieHeader(state), Origin: server, Referer: server + "/" }),
    getCsrfToken: () => state.cookies.csrftoken ?? null,
    onResponse: (res) => captureCookies(state, res, stateFile),
  });

  class NodeWebSocket extends WsWebSocket {
    constructor(url: string, protocols: string[]) {
      super(url, protocols, { headers: { Cookie: cookieHeader(state), Origin: server } });
      this.on("error", (e) => {
        if (verbose) err(`[ws] ${e.message}`);
      });
    }
  }
  const log: RelayLogger = (level, message, extra) => {
    if (!verbose && level === "debug") return;
    if (!verbose && level === "info") return;
    err(`[relay:${level}] ${message}${extra !== undefined ? " " + String(extra) : ""}`);
  };
  const relay = new RelayClient({
    url: relayUrl(server),
    appVersion: APP_VERSION,
    WebSocket: NodeWebSocket as unknown as WebSocketCtor,
    timers: realTimers,
    log,
  });
  configureRuntime({ api, storage, relay, timers: realTimers, appVersion: APP_VERSION });
  wireStores(relay);

  const requireAuth = async (): Promise<void> => {
    const status = await authStore.getState().bootstrap();
    if (status !== "authenticated") {
      throw new CliError(authStore.getState().error ? `cannot reach ${server}: ${authStore.getState().error}` : "not logged in (run: login --email … --password …)");
    }
  };
  const connectRelay = async (): Promise<void> => {
    relay.connect();
    await relay.whenReady(15_000);
  };
  const printMessages = (messages: { role: string; content: string; thinking?: string; created_at: string; aborted?: boolean }[]) => {
    for (const m of messages) {
      out(`message role=${m.role} created_at=${m.created_at}${m.aborted ? " aborted=true" : ""} content=${q(m.content)}${m.thinking ? ` thinking=${q(m.thinking)}` : ""}`);
    }
  };

  try {
    switch (args.command) {
      case "register": {
        const email = requireOpt(args, "email");
        const password = requireOpt(args, "password");
        await authStore.getState().bootstrap();
        const result = await authStore.getState().register(email, password);
        if (!result) throw new CliError(authStore.getState().error ?? "register failed");
        if (result === "verify") {
          out(`registered email=${email} verification_required=true (run: verify-email --email ${email} --code ... with the mailed code)`);
          return;
        }
        await loadAccount();
        out(`registered email=${email} signed_in=true`);
        return;
      }
      case "verify-email": {
        const email = requireOpt(args, "email");
        const code = requireOpt(args, "code");
        await authStore.getState().bootstrap();
        if (!(await authStore.getState().verifyEmail(email, code))) throw new CliError(authStore.getState().error ?? "verification failed");
        await loadAccount();
        out(`verified email=${email} signed_in=true`);
        return;
      }
      case "resend-code": {
        const email = requireOpt(args, "email");
        await authStore.getState().bootstrap();
        if (!(await authStore.getState().resendCode(email))) throw new CliError(authStore.getState().error ?? "resend failed");
        out(`code requested email=${email}`);
        return;
      }
      case "login": {
        const email = requireOpt(args, "email");
        const password = requireOpt(args, "password");
        await authStore.getState().bootstrap();
        const ok = await authStore.getState().login(email, password, undefined, optString(args, "totp"));
        if (!ok) {
          const st = authStore.getState();
          if (st.pendingVerification) throw new CliError("e-mail not confirmed: run verify-email --email … --code … (or resend-code)");
          if (st.totpRequired) throw new CliError(st.errorCode === "E_TOTP_INVALID" ? "wrong two-step code" : "two-step sign-in is on: add --totp CODE");
          throw new CliError(st.error ?? "login failed");
        }
        await loadAccount();
        const me = authStore.getState().me!;
        out(`logged in email=${me.email} totp_enabled=${me.totp_enabled}`);
        return;
      }
      case "totp-setup": {
        await requireAuth();
        const res = await authStore.getState().totpSetup();
        if (!res) throw new CliError(authStore.getState().error ?? "setup failed");
        out(`totp_secret=${res.secret}`);
        out(`otpauth_url=${res.otpauth_url}`);
        out("confirm with: totp-enable --code <code from the app>");
        return;
      }
      case "totp-enable": {
        const code = requireOpt(args, "code");
        await requireAuth();
        if (!(await authStore.getState().totpEnable(code))) throw new CliError(authStore.getState().error ?? "enable failed");
        out("two-step sign-in enabled");
        return;
      }
      case "totp-disable": {
        const code = requireOpt(args, "code");
        const password = requireOpt(args, "password");
        await requireAuth();
        if (!(await authStore.getState().totpDisable(password, code))) throw new CliError(authStore.getState().error ?? "disable failed");
        out("two-step sign-in disabled");
        return;
      }
      case "reset-request": {
        const email = requireOpt(args, "email");
        await authStore.getState().bootstrap();
        if (!(await authStore.getState().requestPasswordReset(email))) throw new CliError(authStore.getState().error ?? "reset request failed");
        out(`reset code requested email=${email} (sent by e-mail when the account exists)`);
        return;
      }
      case "reset-confirm": {
        const email = requireOpt(args, "email");
        const code = requireOpt(args, "code");
        const password = requireOpt(args, "password");
        await authStore.getState().bootstrap();
        if (!(await authStore.getState().confirmPasswordReset(email, code, password))) throw new CliError(authStore.getState().error ?? "reset failed");
        out(`password reset email=${email} (every session was signed out: run login with the new password)`);
        return;
      }
      case "auth-key": {
        const email = requireOpt(args, "email");
        const password = requireOpt(args, "password");
        const keys = await deriveLoginKeys(email, password);
        out(`auth_key_b64url=${authKeyToPassword(keys.authKey)}`);
        return;
      }
      case "logout": {
        await authStore.getState().bootstrap();
        await authStore.getState().logout();
        out("logged out");
        return;
      }
      case "me": {
        await requireAuth();
        const me = authStore.getState().me!;
        out(`email=${me.email} created_at=${me.created_at} totp_enabled=${me.totp_enabled} registration_enabled=${me.registration_enabled}`);
        return;
      }
      case "devices": {
        await requireAuth();
        const list = await devicesStore.getState().refresh();
        const e = devicesStore.getState().error;
        if (e) throw new CliError(e);
        if (list.length === 0) out("no devices");
        for (const d of list) {
          out(`device id=${d.id} name=${q(d.name)} platform=${d.platform || "-"} tray_version=${d.tray_version || "-"} online=${d.online} paired=${d.paired} last_seen_at=${d.last_seen_at ?? "-"}`);
        }
        return;
      }
      case "pairings": {
        const list = await storage.pairings.list();
        if (list.length === 0) out("no pairings");
        for (const p of list) out(`pairing device_id=${p.device_id} name=${q(p.name)} pairing_id=${b64urlEncode(p.pairing_id)} created_at=${p.created_at}`);
        return;
      }
      case "pair": {
        // Accepts XXXX-XXXX-XXXX, lowercase, no dashes, or the tray's full "PAIRING CODE: …" line.
        const rawCode = requireOpt(args, "code");
        const code = rawCode.includes(":") ? rawCode.slice(rawCode.lastIndexOf(":") + 1) : rawCode;
        await requireAuth();
        await connectRelay();
        const rec = await pairDevice(relay, code, {
          store: storage.pairings,
          onStep: (s) => {
            if (verbose) err(`[pair] ${s}`);
          },
        });
        sessionsStore.getState().close(rec.device_id);
        devicesStore.getState().markPaired(rec.device_id, rec.name);
        await devicesStore.getState().sync();
        const syncError = devicesStore.getState().syncError;
        // Without the pairings key (derived at login, kept in the state file) the sync is a silent no-op.
        const synced = !syncError && hasSessionPairingsKey();
        out(`paired device_id=${rec.device_id} name=${q(rec.name)} pairing_id=${b64urlEncode(rec.pairing_id)} synced=${synced ? "true" : "false"}`);
        if (syncError) err(`[sync] ${syncError}`);
        else if (!synced) err("[sync] not synced to your other browsers: run login first");
        return;
      }
      case "unpair": {
        const device = requireOpt(args, "device");
        await storage.pairings.delete(device);
        out(`unpaired device_id=${device}`);
        return;
      }
      case "models": {
        const device = requireOpt(args, "device");
        await requireAuth();
        await connectRelay();
        const models = await modelsStore.getState().list(device);
        const running = await modelsStore.getState().listRunning(device).catch(() => []);
        const loaded = new Set(running.map((r) => r.name));
        const info = sessionsStore.getState().sessions[device]?.device_info;
        if (info) out(`device_info tray_version=${info.tray_version} platform=${info.platform} ollama=${info.ollama.status}${info.ollama.version ? "/" + info.ollama.version : ""} capabilities=${info.capabilities.join(",")}`);
        if (models.length === 0) out("no models");
        for (const m of models) {
          out(`model name=${m.name} size=${m.size} family=${m.details.family ?? "-"} parameter_size=${m.details.parameter_size ?? "-"} quantization=${m.details.quantization_level ?? "-"} running=${loaded.has(m.name)}`);
        }
        return;
      }
      case "chat": {
        const device = requireOpt(args, "device");
        const model = requireOpt(args, "model");
        const prompt = requireOpt(args, "prompt");
        await requireAuth();
        await connectRelay();
        const conv = chatStore.getState().create({ device_id: device, model });
        let printed = "";
        let printedThinking = "";
        const unsub = chatStore.subscribe((s) => {
          const a = s.conversations[conv.id]?.messages.find((m) => m.role === "assistant");
          if (!a) return;
          if (a.thinking && a.thinking.length > printedThinking.length && verbose) {
            process.stderr.write(a.thinking.slice(printedThinking.length));
            printedThinking = a.thinking;
          }
          if (a.content.length > printed.length) {
            process.stdout.write(a.content.slice(printed.length));
            printed = a.content;
          }
          if (s.streaming?.stalled) err("[chat] no chunk for 120 s (stalled)");
        });
        const started = Date.now();
        const done = await chatStore.getState().send(conv.id, prompt, args.opts.think === true ? { think: true } : {});
        unsub();
        if (printed.length > 0) process.stdout.write("\n");
        if (!done) throw new CliError(chatStore.getState().error ?? "chat failed");
        const st = done.stats ?? {};
        const tps = st.eval_count && st.eval_duration ? (st.eval_count / (st.eval_duration / 1e9)).toFixed(1) : "-";
        out(
          `done reason=${done.done_reason} conversation_id=${conv.id} wall_ms=${Date.now() - started} ` +
            `prompt_eval_count=${st.prompt_eval_count ?? "-"} eval_count=${st.eval_count ?? "-"} eval_ms=${ms(st.eval_duration)} ` +
            `total_ms=${ms(st.total_duration)} load_ms=${ms(st.load_duration)} tokens_per_s=${tps}${done.message_id ? " message_id=" + done.message_id : ""}`,
        );
        return;
      }
      case "history": {
        const device = requireOpt(args, "device");
        await requireAuth();
        await connectRelay();
        const get = optString(args, "get");
        if (get) {
          const conv = await historyStore.getState().getPrivate(device, get);
          out(`conversation id=${conv.id} title=${q(conv.title)} model=${conv.model} created_at=${conv.created_at} updated_at=${conv.updated_at} messages=${conv.messages.length}`);
          printMessages(conv.messages);
          return;
        }
        const list = await historyStore.getState().listPrivate(device);
        if (list.length === 0) out("no conversations");
        for (const c of list) out(`conversation id=${c.id} title=${q(c.title)} model=${c.model} messages=${c.message_count} updated_at=${c.updated_at}`);
        return;
      }
      case "agents": {
        const device = requireOpt(args, "device");
        const model = optString(args, "model") ?? "qwen2.5:0.5b";
        const prompt = optString(args, "prompt");
        await requireAuth();
        await connectRelay();
        const lib = libraryStore.getState();
        const first = await lib.load(device, { force: true });
        if (first.error) throw new CliError(first.error);
        if (!first.supported) throw new CliError("the tray does not keep agents (no \"agents\" capability)");
        const skill = await lib.saveSkill(device, { ...newSkill(), name: "Interop skill", description: "Every request", category: "misc", instructions: "Answer in Portuguese." });
        out(`skill saved id=${skill.id} name=${q(skill.name)} category=${skill.category}`);
        const agent = await lib.saveAgent(device, { ...newAgent(model), name: "Interop agent", instructions: "Answer with one word.", options: { temperature: 0 }, skills: "selected", skill_ids: [skill.id] });
        out(`agent saved id=${agent.id} model=${agent.model} skills=${agent.skill_ids.length} options=${JSON.stringify(agent.options ?? {})}`);
        const listed = await libraryStore.getState().load(device, { force: true });
        out(`library agents=${listed.agents.length} skills=${listed.skills.length}`);
        if (prompt) {
          const conv = chatStore.getState().create({ device_id: device, model: agent.model });
          const system = composeSystem(agent, activeSkills(agent, listed.skills, []));
          const done = await chatStore.getState().send(conv.id, prompt, { system, agent_id: agent.id, ...(agent.options ? { options: agent.options } : {}) });
          if (!done) throw new CliError(chatStore.getState().error ?? "chat failed");
          const reply = chatStore.getState().conversations[conv.id]?.messages.find((m) => m.role === "assistant")?.content ?? "";
          out(`agent chat done reason=${done.done_reason} reply=${q(reply.trim().slice(0, 80))}`);
          chatStore.getState().remove(conv.id);
          const stored = await historyStore.getState().getPrivate(device, conv.id);
          out(`conversation agent=${stored.agent_id === agent.id ? "kept" : "missing"} messages=${stored.messages.length} roles=${stored.messages.map((m) => m.role).join(",")}`);
          await historyStore.getState().deletePrivate(device, conv.id);
        }
        await lib.deleteSkill(device, skill.id);
        await lib.deleteAgent(device, agent.id);
        const end = await libraryStore.getState().load(device, { force: true });
        out(`deleted agents=${end.agents.length} skills=${end.skills.length}`);
        return;
      }
      default:
        throw new CliError(`unknown command ${args.command} (try --help)`);
    }
  } finally {
    sessionsStore.getState().closeAll();
    relay.disconnect();
    await storage.close();
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    const code = e instanceof Error ? (e as { code?: unknown }).code : undefined;
    err(`error: ${typeof code === "string" && !msg.startsWith(code) ? code + ": " : ""}${msg}`);
    process.exit(1);
  },
);
