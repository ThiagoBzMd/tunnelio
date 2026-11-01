// Authentication (SPEC §11.2, rev. 1.3): cookie session + CSRF bootstrap, e-mail verification at
// sign-up, optional two-step sign-in (TOTP), password reset by e-mail code. The typed password
// never leaves the browser: `deriveLoginKeys` turns it into the auth key the server checks and the
// pairings key that seals the synced pairings. The pairings key is kept in a module variable (never
// in zustand state) and, so that a reload keeps syncing, in local storage while signed in; both
// are cleared on sign-out.

import { createStore } from "zustand/vanilla";
import { authKeyToPassword, deriveLoginKeys, zeroizeLoginKeys, type LoginKeys } from "../crypto/auth";
import { zeroize } from "../crypto/bytes";
import { ApiError, type Me, type ServerFlags } from "../lib/api";
import { getRuntime } from "./runtime";
import { errorCode, errorMessage } from "./util";

export type AuthStatus = "unknown" | "anonymous" | "authenticated";

export const DEFAULT_FLAGS: ServerFlags = { registration_enabled: true, email_enabled: false, bot_check_site_key: null, bot_check_script_url: null, bot_check_global: null };

export interface AuthState {
  status: AuthStatus;
  me: Me | null;
  /** Feature flags from the server (known even before signing in). */
  flags: ServerFlags;
  busy: boolean;
  error: string | null;
  /** Machine-readable code of `error` (e.g. `E_BAD_CODE`), when the server sent one. */
  errorCode: string | null;
  /** Sign-in paused: this e-mail must confirm the mailed code first (sign-up, or login → E_EMAIL_UNVERIFIED). */
  pendingVerification: string | null;
  /** Sign-in paused: the account has two-step sign-in and the code is missing/wrong. */
  totpRequired: boolean;
  /** A password change disconnected every computer (the devices screen explains and offers to pair again). */
  disconnected: boolean;
  /**
   * The pairings key of this sign-in is at hand (memory, restored from local storage after a
   * reload). False while signed in = the browser kept the cookie but lost its local data (a
   * home-screen app on iOS, storage cleared): the synced pairings can be brought back with the
   * password (pairing-sync.ts `unlockPairings`).
   */
  pairingsKeyPresent: boolean;

  /** Prime CSRF and load `me`. Call once at app start. */
  bootstrap(): Promise<AuthStatus>;
  refresh(): Promise<Me | null>;
  /** `totpCode` is the 6-digit two-step code (after `totpRequired`). */
  login(email: string, password: string, botCheckToken?: string, totpCode?: string): Promise<boolean>;
  /** `"signed_in"` (no e-mail on the server) or `"verify"` (a code was mailed; `pendingVerification` set). */
  register(email: string, password: string, botCheckToken?: string): Promise<"signed_in" | "verify" | false>;
  /** Mailed code → signed in. The pairings sync starts right away when the sign-up happened in this tab. */
  verifyEmail(email: string, code: string): Promise<boolean>;
  resendCode(email: string, botCheckToken?: string): Promise<boolean>;
  logout(): Promise<void>;
  /** Changes the password; the server disconnects every computer (`disconnected`). */
  changePassword(currentPassword: string, newPassword: string): Promise<boolean>;
  deleteAccount(password: string): Promise<boolean>;
  /** Mails a 6-digit code. Always succeeds for unknown e-mails (no enumeration). */
  requestPasswordReset(email: string, botCheckToken?: string): Promise<boolean>;
  /** Code + new password (sent as its derived auth key). Wrong/expired code → false with `errorCode` E_BAD_CODE. */
  confirmPasswordReset(email: string, code: string, newPassword: string): Promise<boolean>;
  /** Two-step sign-in: a pending secret to show as QR / text; active only after `totpEnable`. */
  totpSetup(): Promise<{ secret: string; otpauth_url: string } | null>;
  totpEnable(code: string): Promise<boolean>;
  totpDisable(password: string, code: string): Promise<boolean>;
  clearError(): void;
  clearDisconnected(): void;
}

export function pickFlags(v: Partial<ServerFlags>, prev: ServerFlags): ServerFlags {
  // The widget needs all three: without its script, or the object the script defines, there is
  // nothing to render.
  const siteKey = typeof v.bot_check_site_key === "string" && v.bot_check_site_key.length > 0 ? v.bot_check_site_key : null;
  const scriptUrl = typeof v.bot_check_script_url === "string" && v.bot_check_script_url.startsWith("https://") ? v.bot_check_script_url : null;
  const globalName = typeof v.bot_check_global === "string" && /^[A-Za-z_$][\w$]*$/.test(v.bot_check_global) ? v.bot_check_global : null;
  const on = Boolean(siteKey && scriptUrl && globalName);
  return {
    registration_enabled: typeof v.registration_enabled === "boolean" ? v.registration_enabled : prev.registration_enabled,
    email_enabled: typeof v.email_enabled === "boolean" ? v.email_enabled : prev.email_enabled,
    bot_check_site_key: on ? siteKey : null,
    bot_check_script_url: on ? scriptUrl : null,
    bot_check_global: on ? globalName : null,
  };
}

type Hook = () => void | Promise<void>;
const logoutHooks = new Set<Hook>();
const disconnectHooks = new Set<Hook>();

/** Other stores register their reset here (avoids circular imports). */
export function registerLogoutHook(fn: Hook): () => void {
  logoutHooks.add(fn);
  return () => logoutHooks.delete(fn);
}

/** Runs after a password change: the server deleted every device, so local pairings/sessions go too. */
export function registerDisconnectHook(fn: Hook): () => void {
  disconnectHooks.add(fn);
  return () => disconnectHooks.delete(fn);
}

const passwordHooks = new Set<Hook>();

/** After a password change, with the new keys in place (the synced preferences are sealed again). */
export function registerPasswordHook(fn: Hook): () => void {
  passwordHooks.add(fn);
  return () => passwordHooks.delete(fn);
}

async function runHooks(hooks: Set<Hook>, what: string): Promise<void> {
  for (const fn of [...hooks]) {
    try {
      await fn();
    } catch (e) {
      console.warn(`[auth] ${what} hook failed`, e);
    }
  }
}

// ── session pairings key ─────────────────────────────────────────────────────

let sessionPairingsKey: Uint8Array | null = null;
/** Keys of a sign-up / sign-in that is waiting for the e-mail or two-step code (same tab only). */
let pendingKeys: { email: string; keys: LoginKeys } | null = null;

/** The pairings key derived at sign-in (a copy), or null after a reload / sign-out. Callers zeroize their copy. */
export function getSessionPairingsKey(): Uint8Array | null {
  return sessionPairingsKey ? new Uint8Array(sessionPairingsKey) : null;
}

export function hasSessionPairingsKey(): boolean {
  return sessionPairingsKey !== null;
}

export function setSessionPairingsKey(key: Uint8Array | null): void {
  if (sessionPairingsKey) zeroize(sessionPairingsKey);
  sessionPairingsKey = key ? new Uint8Array(key) : null;
}

function keepPending(email: string, keys: LoginKeys): void {
  dropPending();
  pendingKeys = { email, keys: { salt: keys.salt, authKey: new Uint8Array(keys.authKey), pairingsKey: new Uint8Array(keys.pairingsKey) } };
}

function dropPending(): void {
  if (pendingKeys) zeroizeLoginKeys(pendingKeys.keys);
  pendingKeys = null;
}

export const authStore = createStore<AuthState>((set, get) => {
  /** The cookie session exists: load `me`, keep the pairings key (memory + storage), connect the relay. */
  const finishSignIn = async (pairingsKey: Uint8Array | null): Promise<void> => {
    const { relay, storage } = getRuntime();
    const me = await get().refresh();
    if (!me) throw new Error("signed in but /me failed");
    setSessionPairingsKey(pairingsKey);
    if (pairingsKey) await storage.session.setPairingsKey(pairingsKey).catch(() => undefined);
    dropPending();
    set({ pendingVerification: null, totpRequired: false, pairingsKeyPresent: pairingsKey !== null });
    relay.connect();
  };

  const fail = (e: unknown, extra: Partial<AuthState> = {}): false => {
    set({ error: errorMessage(e), errorCode: errorCode(e), ...extra });
    return false;
  };

  return {
    status: "unknown",
    me: null,
    flags: DEFAULT_FLAGS,
    busy: false,
    error: null,
    errorCode: null,
    pendingVerification: null,
    totpRequired: false,
    disconnected: false,
    pairingsKeyPresent: false,

    bootstrap: async () => {
      const { api, storage } = getRuntime();
      await api.getCsrf().catch(() => undefined);
      await get().refresh();
      // Still signed in after a reload: the pairings key remembered at sign-in keeps the sync going.
      if (get().status === "authenticated" && !hasSessionPairingsKey()) {
        const key = await storage.session.getPairingsKey().catch(() => null);
        if (key) {
          setSessionPairingsKey(key);
          zeroize(key);
        }
      }
      set({ pairingsKeyPresent: hasSessionPairingsKey() });
      return get().status;
    },

    refresh: async () => {
      const { api } = getRuntime();
      try {
        const res = await api.me();
        if (res.authenticated === false || typeof (res as Partial<Me>).email !== "string") {
          set({ me: null, status: "anonymous", flags: pickFlags(res, get().flags), error: null });
          return null;
        }
        const me = res as Me;
        set({ me, status: "authenticated", flags: pickFlags(me, get().flags), error: null });
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.isAuthError) {
          set({ me: null, status: "anonymous" });
          return null;
        }
        set({ error: errorMessage(e) });
        return null;
      }
    },

    login: async (email, password, botCheckToken, totpCode) => {
      const { api } = getRuntime();
      set({ busy: true, error: null, errorCode: null });
      let keys: LoginKeys | null = null;
      try {
        keys = await deriveLoginKeys(email, password);
        await api.login(email, authKeyToPassword(keys.authKey), botCheckToken, totpCode);
        await finishSignIn(keys.pairingsKey);
        return true;
      } catch (e) {
        const code = errorCode(e);
        if (code === "E_EMAIL_UNVERIFIED") {
          if (keys) keepPending(email, keys);
          set({ pendingVerification: email, status: "anonymous", me: null });
          return false;
        }
        if (code === "E_TOTP_REQUIRED") {
          // No message: the form shows the code field. (E_TOTP_INVALID keeps the field and shows the error.)
          set({ totpRequired: true, status: "anonymous", me: null, errorCode: code });
          return false;
        }
        return fail(e, { status: "anonymous", me: null, totpRequired: code === "E_TOTP_INVALID" });
      } finally {
        if (keys) zeroizeLoginKeys(keys);
        set({ busy: false });
      }
    },

    register: async (email, password, botCheckToken) => {
      const { api } = getRuntime();
      set({ busy: true, error: null, errorCode: null });
      let keys: LoginKeys | null = null;
      try {
        keys = await deriveLoginKeys(email, password);
        const res = await api.register(email, authKeyToPassword(keys.authKey), botCheckToken);
        if (res.verification_required) {
          keepPending(email, keys);
          set({ pendingVerification: email });
          return "verify";
        }
        // Registration signs the browser in (SPEC §11.2); fall back to a login only when it did not.
        if (!(await get().refresh())) await api.login(email, authKeyToPassword(keys.authKey));
        await finishSignIn(keys.pairingsKey);
        return "signed_in";
      } catch (e) {
        return fail(e);
      } finally {
        if (keys) zeroizeLoginKeys(keys);
        set({ busy: false });
      }
    },

    verifyEmail: async (email, code) => {
      const { api } = getRuntime();
      set({ busy: true, error: null, errorCode: null });
      try {
        await api.verifyEmail(email.trim(), code.replace(/\s+/g, ""));
        // Pairings sync needs the key derived from the password: available when the sign-up
        // happened in this tab, otherwise from the next sign-in.
        const keys = pendingKeys && pendingKeys.email === email.trim() ? pendingKeys.keys.pairingsKey : null;
        await finishSignIn(keys);
        return true;
      } catch (e) {
        return fail(e);
      } finally {
        set({ busy: false });
      }
    },

    resendCode: async (email, botCheckToken) => {
      const { api } = getRuntime();
      set({ busy: true, error: null, errorCode: null });
      try {
        await api.resendCode(email.trim(), botCheckToken);
        return true;
      } catch (e) {
        return fail(e);
      } finally {
        set({ busy: false });
      }
    },

    logout: async () => {
      const { api, relay, storage } = getRuntime();
      set({ busy: true });
      try {
        await api.logout();
      } catch {
        /* the cookie may already be gone */
      }
      relay.disconnect();
      setSessionPairingsKey(null);
      set({ pairingsKeyPresent: false });
      await storage.session.clearPairingsKey().catch(() => undefined);
      dropPending();
      await runHooks(logoutHooks, "logout");
      set({ status: "anonymous", me: null, busy: false, error: null, errorCode: null, pendingVerification: null, totpRequired: false, disconnected: false });
    },

    changePassword: async (currentPassword, newPassword) => {
      const { api } = getRuntime();
      const email = get().me?.email;
      set({ busy: true, error: null, errorCode: null });
      let cur: LoginKeys | null = null;
      let next: LoginKeys | null = null;
      try {
        if (!email) throw new Error("not signed in");
        [cur, next] = await Promise.all([deriveLoginKeys(email, currentPassword), deriveLoginKeys(email, newPassword)]);
        await api.changePassword(authKeyToPassword(cur.authKey), authKeyToPassword(next.authKey));
        setSessionPairingsKey(next.pairingsKey);
        await getRuntime().storage.session.setPairingsKey(next.pairingsKey).catch(() => undefined);
        // The preferences stay: sealed again with the key of the new password.
        await runHooks(passwordHooks, "password");
        // The server deleted every device of the account: forget the local pairings and sessions.
        await runHooks(disconnectHooks, "disconnect");
        set({ disconnected: true });
        return true;
      } catch (e) {
        return fail(e);
      } finally {
        if (cur) zeroizeLoginKeys(cur);
        if (next) zeroizeLoginKeys(next);
        set({ busy: false });
      }
    },

    deleteAccount: async (password) => {
      const { api, relay, storage } = getRuntime();
      const email = get().me?.email;
      set({ busy: true, error: null, errorCode: null });
      let keys: LoginKeys | null = null;
      try {
        if (!email) throw new Error("not signed in");
        keys = await deriveLoginKeys(email, password);
        await api.deleteAccount(authKeyToPassword(keys.authKey));
      } catch (e) {
        set({ busy: false });
        return fail(e);
      } finally {
        if (keys) zeroizeLoginKeys(keys);
      }
      relay.disconnect();
      setSessionPairingsKey(null);
      set({ pairingsKeyPresent: false });
      await storage.session.clearPairingsKey().catch(() => undefined);
      dropPending();
      await storage.pairings.clear().catch(() => undefined);
      await runHooks(logoutHooks, "logout");
      set({ status: "anonymous", me: null, busy: false, disconnected: false });
      return true;
    },

    requestPasswordReset: async (email, botCheckToken) => {
      const { api } = getRuntime();
      set({ busy: true, error: null, errorCode: null });
      try {
        await api.passwordReset(email.trim(), botCheckToken);
        return true;
      } catch (e) {
        return fail(e);
      } finally {
        set({ busy: false });
      }
    },

    confirmPasswordReset: async (email, code, newPassword) => {
      const { api } = getRuntime();
      set({ busy: true, error: null, errorCode: null });
      let keys: LoginKeys | null = null;
      try {
        keys = await deriveLoginKeys(email, newPassword);
        await api.passwordResetConfirm(email.trim(), code.replace(/\s+/g, ""), authKeyToPassword(keys.authKey));
        return true;
      } catch (e) {
        return fail(e);
      } finally {
        if (keys) zeroizeLoginKeys(keys);
        set({ busy: false });
      }
    },

    totpSetup: async () => {
      const { api } = getRuntime();
      set({ busy: true, error: null, errorCode: null });
      try {
        return await api.totpSetup();
      } catch (e) {
        fail(e);
        return null;
      } finally {
        set({ busy: false });
      }
    },

    totpEnable: async (code) => {
      const { api } = getRuntime();
      set({ busy: true, error: null, errorCode: null });
      try {
        await api.totpEnable(code.replace(/\s+/g, ""));
        await get().refresh();
        return true;
      } catch (e) {
        return fail(e);
      } finally {
        set({ busy: false });
      }
    },

    totpDisable: async (password, code) => {
      const { api } = getRuntime();
      const email = get().me?.email;
      set({ busy: true, error: null, errorCode: null });
      let keys: LoginKeys | null = null;
      try {
        if (!email) throw new Error("not signed in");
        keys = await deriveLoginKeys(email, password);
        await api.totpDisable(authKeyToPassword(keys.authKey), code.replace(/\s+/g, ""));
        await get().refresh();
        return true;
      } catch (e) {
        return fail(e);
      } finally {
        if (keys) zeroizeLoginKeys(keys);
        set({ busy: false });
      }
    },

    clearError: () => set({ error: null, errorCode: null }),
    clearDisconnected: () => set({ disconnected: false }),
  };
});
