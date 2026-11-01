// REST client (SPEC §11.2): fetch with cookies, Django CSRF header, typed endpoints.
// `createApi` is injectable (base URL, fetch, cookie/CSRF access) so the Node CLI can reuse it.

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiOptions {
  /** Origin such as `http://localhost:8080`; empty = same origin. */
  baseUrl?: string;
  fetch?: FetchLike;
  /** Returns the current CSRF token (browser default: the `csrftoken` cookie). */
  getCsrfToken?: () => string | null;
  /** Extra headers per request (Node: `Cookie`, `Origin`). */
  headers?: () => Record<string, string>;
  /** Observe every response (Node: capture `Set-Cookie`). */
  onResponse?: (res: Response) => void;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null = null,
    public readonly body: unknown = null,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Server-side feature flags, also returned to anonymous callers of `GET /api/auth/me`. */
export interface ServerFlags {
  registration_enabled: boolean;
  /** Password reset by e-mail is available (`EMAIL_URL` set). */
  email_enabled: boolean;
  /** Bot check site key; `null` when the widget is disabled. */
  bot_check_site_key: string | null;
  /** Where the widget's script comes from (the server's BOT_CHECK_SCRIPT_URL); `null` when disabled. */
  bot_check_script_url: string | null;
  /** The object that script defines (`window[…]`, the server's BOT_CHECK_GLOBAL); `null` when disabled. */
  bot_check_global: string | null;
}

export interface Me {
  email: string;
  created_at: string;
  /** Two-step sign-in (TOTP) is on for this account. */
  totp_enabled: boolean;
  registration_enabled: boolean;
  email_enabled?: boolean;
  bot_check_site_key?: string | null;
  bot_check_script_url?: string | null;
  bot_check_global?: string | null;
}

/** Raw `GET /api/auth/me` body: the real server answers 200 with `authenticated:false` when signed out. */
export type MeResponse = (Me & { authenticated?: true }) | ({ authenticated: false } & Partial<ServerFlags>);

export interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  tray_version: string;
  created_at: string;
  last_seen_at: string | null;
  online: boolean;
}

/** `GET/PUT /api/devices/pairings`: one encrypted blob with every pairing of the account (≤ 64 KiB). */
export interface PairingsBlobWire {
  timestamp: string;
  /** b64url of nonce || ct || tag */
  ciphertext: string;
}

/** `GET /api/auth/sessions`: one signed-in browser (what it announces about itself, no IP, no place). */
export interface LoginSessionRecord {
  id: number;
  browser: string;
  os: string;
  device: "computer" | "phone" | "tablet" | "other";
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export function readCookie(name: string): string | null {
  const doc = (globalThis as { document?: { cookie?: string } }).document;
  const raw = doc?.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function extractError(body: unknown, status: number): { message: string; code: string | null; retryAfterMs: number | null } {
  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    const code = typeof b.code === "string" ? b.code : null;
    const retry = typeof b.retry_after_ms === "number" ? b.retry_after_ms : null;
    const firstString = (v: unknown): string | null => {
      if (typeof v === "string") return v;
      if (Array.isArray(v) && typeof v[0] === "string") return v[0];
      return null;
    };
    const msg =
      firstString(b.detail) ??
      firstString(b.message) ??
      firstString(b.error) ??
      firstString(b.non_field_errors) ??
      firstString(b.email) ??
      firstString(b.password) ??
      firstString(b.name) ??
      code ??
      `HTTP ${status}`;
    return { message: msg, code, retryAfterMs: retry };
  }
  // A plain-text reason is shown; an HTML error page (a proxy, Django's 403 without JSON) never is.
  if (typeof body === "string" && body.trim().length > 0 && !/^\s*</.test(body)) return { message: body.slice(0, 200), code: null, retryAfterMs: null };
  return { message: `HTTP ${status}`, code: null, retryAfterMs: null };
}

export function createApi(opts: ApiOptions = {}) {
  const baseUrl = (opts.baseUrl ?? "").replace(/\/+$/, "");
  const fetchImpl: FetchLike =
    opts.fetch ??
    ((input, init) => {
      const f = (globalThis as { fetch?: FetchLike }).fetch;
      if (!f) throw new Error("fetch is not available");
      return f(input, init);
    });
  const getCsrf = opts.getCsrfToken ?? (() => readCookie("csrftoken"));

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers?.() ?? {}) };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (UNSAFE.has(method)) {
      const token = getCsrf();
      if (token) headers["X-CSRFToken"] = token;
    }
    const init: RequestInit = { method, headers, credentials: "include" };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res: Response;
    try {
      res = await fetchImpl(baseUrl + path, init);
    } catch (e) {
      throw new ApiError(e instanceof Error ? e.message : "network error", 0, "E_NETWORK");
    }
    opts.onResponse?.(res);
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const { message, code, retryAfterMs } = extractError(parsed, res.status);
      throw new ApiError(message, res.status, code, parsed, retryAfterMs);
    }
    return parsed as T;
  }

  const api = {
    request,

    // ── auth (§11.2) ─────────────────────────────────────────────────────
    /** Primes the CSRF cookie; returns the token when the server echoes it in the body. */
    async getCsrf(): Promise<{ csrftoken: string | null }> {
      const body = await request<Record<string, unknown> | null>("GET", "/api/auth/csrf");
      const fromBody = body && typeof body === "object" ? (body.csrftoken ?? body.csrfToken ?? body.token) : null;
      return { csrftoken: typeof fromBody === "string" ? fromBody : getCsrf() };
    },
    /**
     * `password` is the derived auth key. With e-mail on the server: 202 `{verification_required:true}`,
     * the account waits for the mailed code (not signed in); otherwise 201 and signed in.
     */
    register: (email: string, password: string, botCheckToken?: string) =>
      request<{ email: string; verification_required?: boolean }>("POST", "/api/auth/register", { email, password, ...(botCheckToken ? { bot_check_token: botCheckToken } : {}) }),
    /** 6-digit code from the registration mail → signed in. 400 `E_BAD_CODE`. */
    verifyEmail: (email: string, code: string) => request<{ email: string }>("POST", "/api/auth/verify-email", { email, code }),
    /** Always 204 (≤ 3 codes per hour; a new code replaces the previous one). */
    resendCode: (email: string, botCheckToken?: string) =>
      request<void>("POST", "/api/auth/resend-code", { email, ...(botCheckToken ? { bot_check_token: botCheckToken } : {}) }),
    /** 401 `E_AUTH`; 403 `E_EMAIL_UNVERIFIED`; 401 `E_TOTP_REQUIRED` (re-submit with `totpCode`); 401 `E_TOTP_INVALID`. */
    login: (email: string, password: string, botCheckToken?: string, totpCode?: string) =>
      request<{ email: string }>("POST", "/api/auth/login", {
        email,
        password,
        ...(botCheckToken ? { bot_check_token: botCheckToken } : {}),
        ...(totpCode ? { totp_code: totpCode } : {}),
      }),
    logout: () => request<void>("POST", "/api/auth/logout"),
    me: () => request<MeResponse>("GET", "/api/auth/me"),
    /** Mails a 6-digit code (valid 15 min). Optional (404 when `EMAIL_URL` is unset); always 204 otherwise. */
    passwordReset: (email: string, botCheckToken?: string) =>
      request<void>("POST", "/api/auth/password-reset", { email, ...(botCheckToken ? { bot_check_token: botCheckToken } : {}) }),
    /**
     * `new_password` is the derived auth key. Wrong/expired/used code → 400 `E_BAD_CODE`. On success
     * every device of the account is deleted (the trays forget their pairings), the pairings blob
     * is deleted, two-step sign-in is turned off and every session is signed out.
     */
    passwordResetConfirm: (email: string, code: string, new_password: string) =>
      request<void>("POST", "/api/auth/password-reset/confirm", { email, code, new_password }),
    /**
     * Both values are derived auth keys (crypto/auth.ts), never the typed passwords. On success every
     * device is deleted, the pairings blob is deleted and the other sessions are signed out.
     */
    changePassword: (current_password: string, new_password: string) =>
      request<void>("POST", "/api/auth/change-password", { current_password, new_password }),
    deleteAccount: (password: string) => request<void>("DELETE", "/api/auth/account", { password }),

    // ── two-step sign-in (TOTP) ──────────────────────────────────────────
    /** A pending secret (not active until `totpEnable`). */
    totpSetup: () => request<{ secret: string; otpauth_url: string }>("POST", "/api/auth/totp/setup"),
    totpEnable: (code: string) => request<void>("POST", "/api/auth/totp/enable", { code }),
    /** `password` is the derived auth key. */
    totpDisable: (password: string, code: string) => request<void>("POST", "/api/auth/totp/disable", { password, code }),

    // ── devices (§11.2) ──────────────────────────────────────────────────
    listDevices: () => request<DeviceRecord[]>("GET", "/api/devices/"),
    renameDevice: (id: string, name: string) => request<DeviceRecord>("PATCH", `/api/devices/${encodeURIComponent(id)}`, { name }),
    deleteDevice: (id: string) => request<void>("DELETE", `/api/devices/${encodeURIComponent(id)}`),
    /** Synced pairings blob; `null` when nothing was synced yet (404). */
    async getPairings(): Promise<PairingsBlobWire | null> {
      try {
        return await request<PairingsBlobWire>("GET", "/api/devices/pairings");
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    putPairings: (blob: PairingsBlobWire) => request<unknown>("PUT", "/api/devices/pairings", blob),
    deletePairings: () => request<void>("DELETE", "/api/devices/pairings"),

    // ── account: synced preferences (sealed) and active sessions ────────
    /** Synced preferences blob (same wire shape as the pairings); `null` when none yet (404). */
    async getPreferences(): Promise<PairingsBlobWire | null> {
      try {
        return await request<PairingsBlobWire>("GET", "/api/auth/preferences");
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    putPreferences: (blob: PairingsBlobWire) => request<unknown>("PUT", "/api/auth/preferences", blob),
    listSessions: () => request<LoginSessionRecord[]>("GET", "/api/auth/sessions"),
    /** Signs that browser out (this one too, when it is the current session). */
    deleteSession: (id: number) => request<void>("DELETE", `/api/auth/sessions/${id}`),
    /** Signs every browser of the account out, this one included. */
    logoutAll: () => request<void>("POST", "/api/auth/sessions/logout-all"),

    // ── catalog ──────────────────────────────────────────────────────────
    /** The Ollama library as the server last fetched it (lib/catalog.ts checks the shape). */
    ollamaCatalog: () => request<unknown>("GET", "/api/catalog/ollama"),

    // ── misc ─────────────────────────────────────────────────────────────
    health: () => request<{ status: string }>("GET", "/healthz"),
  };
  return api;
}

export type Api = ReturnType<typeof createApi>;
