// In-memory Django-like server for the REST client and store tests. Implements the SPEC §11.2 routes
// of rev. 1.3 (e-mail verification, two-step sign-in, password reset by code, synced pairings) with
// cookie sessions + CSRF, so `createApi` runs unmodified against it.

import type { FetchLike } from "../../src/lib/api";
import { randomTotpSecret, totpValid } from "./totp";

interface User {
  email: string;
  /** What the browser sends: the derived auth key (never a typed password). */
  password: string;
  created_at: string;
  /** False until the mailed sign-up code was confirmed (only with e-mail on). */
  active: boolean;
  /** Two-step sign-in secret (base32) once enabled. */
  totp: string | null;
  /** A `totp/setup` secret waiting for `totp/enable`. */
  pendingTotp: string | null;
}

interface Code {
  code: string;
  expiresAt: number;
  attempts: number;
  used: boolean;
}

export interface FakeServerState {
  users: Map<string, User>;
  sessions: Map<string, string>; // sessionid → email
  devices: Map<string, { id: string; name: string; platform: string; tray_version: string; created_at: string; last_seen_at: string | null; online: boolean; owner: string }>;
  pairings: Map<string, { timestamp: string; ciphertext: string }>; // email → synced pairings blob
  preferences: Map<string, { timestamp: string; ciphertext: string }>; // email → synced preferences blob
  registrationEnabled: boolean;
  /** `EMAIL_URL` set: sign-up needs the mailed code, password reset by code is available. */
  emailEnabled: boolean;
  verifyCodes: Map<string, Code>;
  resetCodes: Map<string, Code>;
  /** "Sent" e-mails, newest last. */
  outbox: { to: string; code: string; kind: "verify" | "reset" }[];
  /** Clock for code expiry and TOTP (ms). */
  now: () => number;
  requests: { method: string; path: string; headers: Record<string, string>; body: unknown }[];
}

const CSRF = "csrf-token-123";
const CODE_TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

export function createFakeServer(): { fetch: FetchLike; state: FakeServerState; cookies: Map<string, string> } {
  const state: FakeServerState = {
    users: new Map(),
    sessions: new Map(),
    devices: new Map(),
    pairings: new Map(),
    preferences: new Map(),
    registrationEnabled: true,
    emailEnabled: true,
    verifyCodes: new Map(),
    resetCodes: new Map(),
    outbox: [],
    now: () => Date.now(),
    requests: [],
  };
  // The "browser" cookie jar lives here so the test can also inspect it.
  const cookies = new Map<string, string>();

  const json = (status: number, body?: unknown, setCookies: string[] = []): Response => {
    const headers = new Headers({ "Content-Type": "application/json" });
    for (const c of setCookies) headers.append("Set-Cookie", c);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  };
  const err = (status: number, code: string, message: string) => json(status, { code, message });
  const normalize = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const newCode = () => String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  const mail = (map: Map<string, Code>, email: string, kind: "verify" | "reset") => {
    const code = newCode();
    map.set(email, { code, expiresAt: state.now() + CODE_TTL_MS, attempts: 0, used: false });
    state.outbox.push({ to: email, code, kind });
  };
  /** Consume `code` for `email`; false for wrong/expired/used (5 wrong tries burn it). */
  const checkCode = (map: Map<string, Code>, email: string, code: unknown): boolean => {
    const entry = map.get(email);
    if (!entry || entry.used || entry.expiresAt <= state.now() || !/^\d{6}$/.test(String(code ?? ""))) return false;
    if (entry.code !== code) {
      entry.attempts += 1;
      entry.used = entry.attempts >= MAX_ATTEMPTS;
      return false;
    }
    map.delete(email);
    return true;
  };
  const dropDevices = (email: string) => {
    for (const [id, d] of [...state.devices]) if (d.owner === email) state.devices.delete(id);
    state.pairings.delete(email);
  };
  const dropSessions = (email: string, keep?: string) => {
    for (const [sid, e] of [...state.sessions]) if (e === email && sid !== keep) state.sessions.delete(sid);
  };

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input, "http://fake");
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    const h = init.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
    const body = typeof init.body === "string" && init.body.length > 0 ? (JSON.parse(init.body) as unknown) : null;
    state.requests.push({ method, path: url.pathname + url.search, headers, body });
    if (init.credentials !== "include") return json(400, { detail: "credentials must be include" });

    // Cookies: the jar is attached automatically (as a browser would).
    const sessionId = cookies.get("sessionid");
    const email = sessionId ? state.sessions.get(sessionId) : undefined;
    const path = url.pathname;

    if (method !== "GET" && path !== "/api/auth/csrf") {
      if (headers["x-csrftoken"] !== cookies.get("csrftoken")) return json(403, { detail: "CSRF Failed: CSRF token missing or incorrect." });
    }
    const setCookie = (name: string, value: string): string => {
      cookies.set(name, value);
      return `${name}=${value}; Path=/; SameSite=Lax`;
    };
    const signIn = (u: User): string[] => {
      const sid = "sess-" + Math.random().toString(36).slice(2);
      state.sessions.set(sid, u.email);
      return [setCookie("sessionid", sid), setCookie("csrftoken", CSRF)];
    };
    const b = (body ?? {}) as Record<string, unknown>;

    if (path === "/api/auth/csrf" && method === "GET") return json(200, { csrftoken: CSRF }, [setCookie("csrftoken", CSRF)]);
    if (path === "/api/auth/register" && method === "POST") {
      if (!state.registrationEnabled) return err(403, "E_REGISTRATION_CLOSED", "Registration is disabled.");
      const addr = normalize(b.email);
      const password = String(b.password ?? "");
      if (!addr.includes("@")) return err(400, "E_INVALID", "A valid e-mail is required.");
      if (password.length < 8) return err(400, "E_WEAK_PASSWORD", "too short");
      const existing = state.users.get(addr);
      if (existing?.active) return err(409, "E_EXISTS", "An account with this e-mail already exists.");
      const user: User = { email: addr, password, created_at: "2026-10-08T00:00:00Z", active: !state.emailEnabled, totp: null, pendingTotp: null };
      state.users.set(addr, user);
      if (state.emailEnabled) {
        mail(state.verifyCodes, addr, "verify");
        return json(202, { email: addr, verification_required: true });
      }
      return json(201, { email: addr }, signIn(user));
    }
    if (path === "/api/auth/verify-email" && method === "POST") {
      const addr = normalize(b.email);
      const u = state.users.get(addr);
      if (!u || u.active || !checkCode(state.verifyCodes, addr, b.code)) return err(400, "E_BAD_CODE", "Wrong or expired code.");
      u.active = true;
      return json(200, { email: addr }, signIn(u));
    }
    if (path === "/api/auth/resend-code" && method === "POST") {
      const u = state.users.get(normalize(b.email));
      if (u && !u.active && state.emailEnabled) mail(state.verifyCodes, u.email, "verify");
      return json(204);
    }
    if (path === "/api/auth/login" && method === "POST") {
      const u = state.users.get(normalize(b.email));
      if (!u || u.password !== b.password) return err(401, "E_AUTH", "Invalid e-mail or password.");
      if (!u.active) return err(403, "E_EMAIL_UNVERIFIED", "Confirm your e-mail first.");
      if (u.totp) {
        if (b.totp_code === undefined) return err(401, "E_TOTP_REQUIRED", "Two-step code required.");
        if (!totpValid(u.totp, String(b.totp_code), state.now())) return err(401, "E_TOTP_INVALID", "Wrong two-step code.");
      }
      return json(200, { email: u.email }, signIn(u));
    }
    if (path === "/api/auth/password-reset" && method === "POST") {
      if (!state.emailEnabled) return err(404, "E_EMAIL_DISABLED", "Password reset by e-mail is not enabled.");
      const u = state.users.get(normalize(b.email));
      if (u?.active) mail(state.resetCodes, u.email, "reset");
      return json(204);
    }
    if (path === "/api/auth/password-reset/confirm" && method === "POST") {
      if (!state.emailEnabled) return err(404, "E_EMAIL_DISABLED", "Password reset by e-mail is not enabled.");
      const addr = normalize(b.email);
      const u = state.users.get(addr);
      if (!u?.active || !checkCode(state.resetCodes, addr, b.code)) return err(400, "E_BAD_CODE", "Wrong or expired code.");
      const next = String(b.new_password ?? "");
      if (next.length < 8) return err(400, "E_WEAK_PASSWORD", "too short");
      u.password = next;
      u.totp = null;
      u.pendingTotp = null;
      dropDevices(addr);
      dropSessions(addr);
      state.preferences.delete(addr); // sealed with the old password's key: nobody can open it
      return json(204);
    }
    if (path === "/api/auth/logout" && method === "POST") {
      if (sessionId) state.sessions.delete(sessionId);
      cookies.delete("sessionid");
      return json(204);
    }
    if (!email) return json(401, { detail: "Authentication credentials were not provided." });
    const user = state.users.get(email)!;

    if (path === "/api/auth/me" && method === "GET") {
      return json(200, {
        authenticated: true,
        email,
        created_at: user.created_at,
        totp_enabled: user.totp !== null,
        registration_enabled: state.registrationEnabled,
        email_enabled: state.emailEnabled,
        bot_check_site_key: null,
        bot_check_script_url: null,
        bot_check_global: null,
      });
    }
    if (path === "/api/auth/change-password" && method === "POST") {
      if (b.current_password !== user.password) return err(400, "E_AUTH", "wrong password");
      user.password = String(b.new_password ?? user.password);
      dropDevices(email);
      dropSessions(email, sessionId);
      return json(204);
    }
    if (path === "/api/auth/account" && method === "DELETE") {
      if (b.password !== user.password) return err(400, "E_AUTH", "wrong password");
      state.users.delete(email);
      dropDevices(email);
      dropSessions(email);
      cookies.delete("sessionid");
      return json(204);
    }
    if (path === "/api/auth/totp/setup" && method === "POST") {
      user.pendingTotp = randomTotpSecret();
      return json(200, { secret: user.pendingTotp, otpauth_url: `otpauth://totp/Tunnelio:${encodeURIComponent(email)}?secret=${user.pendingTotp}&issuer=Tunnelio&algorithm=SHA1&digits=6&period=30` });
    }
    if (path === "/api/auth/totp/enable" && method === "POST") {
      if (!user.pendingTotp || !totpValid(user.pendingTotp, String(b.code ?? ""), state.now())) return err(400, "E_BAD_CODE", "Wrong code.");
      user.totp = user.pendingTotp;
      user.pendingTotp = null;
      return json(204);
    }
    if (path === "/api/auth/totp/disable" && method === "POST") {
      if (b.password !== user.password) return err(400, "E_AUTH", "wrong password");
      if (!user.totp || !totpValid(user.totp, String(b.code ?? ""), state.now())) return err(400, "E_BAD_CODE", "Wrong code.");
      user.totp = null;
      return json(204);
    }
    if (path === "/api/devices/" && method === "GET") {
      return json(200, [...state.devices.values()].filter((d) => d.owner === email).map(({ owner: _o, ...d }) => d));
    }
    if (path === "/api/auth/preferences") {
      if (method === "GET") {
        const p = state.preferences.get(email);
        return p ? json(200, p) : err(404, "E_NOT_FOUND", "no synced preferences");
      }
      if (method === "PUT") {
        if (typeof b.timestamp !== "string" || typeof b.ciphertext !== "string") return err(400, "E_INVALID", "bad blob");
        if (b.ciphertext.length > 44 * 1024) return err(413, "E_TOO_LARGE", "preferences blob exceeds 32 KiB");
        const existed = state.preferences.has(email);
        state.preferences.set(email, { timestamp: b.timestamp, ciphertext: b.ciphertext });
        return json(existed ? 200 : 201, { timestamp: b.timestamp });
      }
    }
    if (path === "/api/auth/sessions" && method === "GET") {
      return json(200, [...state.sessions.entries()].filter(([, e]) => e === email).map(([sid], i) => ({ id: i + 1, browser: "Node", os: "", device: "other", created_at: new Date(state.now()).toISOString(), last_seen_at: new Date(state.now()).toISOString(), current: sid === cookies.get("sessionid") })));
    }
    if (path === "/api/devices/pairings") {
      if (method === "GET") {
        const p = state.pairings.get(email);
        return p ? json(200, p) : err(404, "E_NOT_FOUND", "no synced pairings");
      }
      if (method === "PUT") {
        if (typeof b.timestamp !== "string" || typeof b.ciphertext !== "string") return err(400, "E_INVALID", "bad blob");
        if (b.ciphertext.length > 64 * 1024) return err(413, "E_TOO_LARGE", "pairings blob exceeds 64 KiB");
        const existed = state.pairings.has(email);
        state.pairings.set(email, { timestamp: b.timestamp, ciphertext: b.ciphertext });
        return json(existed ? 200 : 201, { timestamp: b.timestamp });
      }
      if (method === "DELETE") {
        state.pairings.delete(email);
        return json(204);
      }
    }
    const dev = path.match(/^\/api\/devices\/([^/]+)$/);
    if (dev) {
      const d = state.devices.get(decodeURIComponent(dev[1]!));
      if (!d || d.owner !== email) return json(404, { detail: "Not found." });
      if (method === "PATCH") {
        d.name = (body as { name: string }).name;
        const { owner: _o, ...rest } = d;
        return json(200, rest);
      }
      if (method === "DELETE") {
        state.devices.delete(d.id);
        return json(204);
      }
    }
    return json(404, { detail: `no route ${method} ${path}` });
  };

  return { fetch, state, cookies };
}
