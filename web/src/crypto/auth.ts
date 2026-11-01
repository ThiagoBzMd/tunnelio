// One password (rev. 1.2/rev. 1.3, vector V8): the sign-in password never reaches the server. The browser
// derives a master key with Argon2id (salt = SHA-256("tunnelio/auth/v1" || email) truncated to
// 16 bytes) and splits it with HKDF into
//   auth_key     — sent as the `password` field of register/login/change-password/reset-confirm
//   pairings_key — seals the synced pairings blob (crypto/sync.ts); never leaves the browser.
// Changing the e-mail would change the salt, so e-mails are immutable on the server.

import { argon2id } from "hash-wasm";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { b64urlEncode } from "./b64url";
import { concat, utf8, zeroize } from "./bytes";

export const AUTH_SALT_LABEL = "tunnelio/auth/v1";
export const AUTH_LOGIN_INFO = "tunnelio/auth/v1/login";
export const AUTH_PAIRINGS_INFO = "tunnelio/auth/v1/pairings";
export const AUTH_ARGON2 = { m_kib: 65536, t: 3, p: 1, tag_len: 32 } as const;
export const AUTH_SALT_BYTES = 16;

/** `trim(lower(email))` — the canonical form the salt is derived from. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** salt = SHA-256("tunnelio/auth/v1" || email_norm)[0:16] */
export function authSalt(email: string): Uint8Array {
  return sha256(concat(utf8(AUTH_SALT_LABEL), utf8(normalizeEmail(email)))).slice(0, AUTH_SALT_BYTES);
}

/** master = Argon2id(NFC(password), salt, m = 64 MiB, t = 3, p = 1, 32 bytes) */
export async function deriveMasterKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  if (salt.length !== AUTH_SALT_BYTES) throw new Error("auth salt must be 16 bytes");
  return argon2id({
    password: utf8(password.normalize("NFC")),
    salt,
    iterations: AUTH_ARGON2.t,
    parallelism: AUTH_ARGON2.p,
    memorySize: AUTH_ARGON2.m_kib,
    hashLength: AUTH_ARGON2.tag_len,
    outputType: "binary",
  });
}

export interface LoginKeys {
  salt: Uint8Array;
  /** 32 bytes; what the server sees is `authKeyToPassword(authKey)`. */
  authKey: Uint8Array;
  /** 32 bytes; seals the synced pairings blob, never leaves the browser. */
  pairingsKey: Uint8Array;
}

export async function deriveLoginKeys(email: string, password: string): Promise<LoginKeys> {
  const salt = authSalt(email);
  const master = await deriveMasterKey(password, salt);
  const authKey = hkdf(sha256, master, undefined, utf8(AUTH_LOGIN_INFO), 32);
  const pairingsKey = hkdf(sha256, master, undefined, utf8(AUTH_PAIRINGS_INFO), 32);
  zeroize(master);
  return { salt, authKey, pairingsKey };
}

export function zeroizeLoginKeys(keys: LoginKeys): void {
  zeroize(keys.authKey);
  zeroize(keys.pairingsKey);
}

/** The `password` field sent to the server: base64url without padding (43 characters). */
export function authKeyToPassword(authKey: Uint8Array): string {
  if (authKey.length !== 32) throw new Error("auth key must be 32 bytes");
  return b64urlEncode(authKey);
}
