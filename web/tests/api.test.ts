// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ApiError, createApi, readCookie, type Me } from "../src/lib/api";
import { createFakeServer } from "./helpers/fake-server";
import { totpCode } from "./helpers/totp";

describe("api client", () => {
  it("sends credentials, the CSRF header on unsafe methods and parses JSON errors", async () => {
    const srv = createFakeServer();
    srv.state.emailEnabled = false;
    const api = createApi({ fetch: srv.fetch, getCsrfToken: () => srv.cookies.get("csrftoken") ?? null });
    await expect(api.me()).rejects.toMatchObject({ status: 401, isAuthError: true });
    const csrf = await api.getCsrf();
    expect(csrf.csrftoken).toBe("csrf-token-123");
    await expect(api.register("a@b.c", "short")).rejects.toMatchObject({ status: 400, code: "E_WEAK_PASSWORD" });
    await expect(api.register("a@b.c", "longenough1")).resolves.toEqual({ email: "a@b.c" });
    await expect(api.login("a@b.c", "wrong")).rejects.toBeInstanceOf(ApiError);
    await api.login("a@b.c", "longenough1");
    const me = await api.me();
    expect(me).toMatchObject({ email: "a@b.c", totp_enabled: false, registration_enabled: true, email_enabled: false });
    const post = srv.state.requests.find((r) => r.path === "/api/auth/login")!;
    expect(post.headers["x-csrftoken"]).toBe("csrf-token-123");
    expect(post.headers["content-type"]).toBe("application/json");
    const get = srv.state.requests.find((r) => r.path === "/api/auth/me")!;
    expect(get.headers["x-csrftoken"]).toBeUndefined();
    await expect(api.logout()).resolves.toBeNull();
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
  });

  it("covers every endpoint path of SPEC §11.2 (rev. 1.3)", async () => {
    const srv = createFakeServer();
    const api = createApi({ fetch: srv.fetch, getCsrfToken: () => srv.cookies.get("csrftoken") ?? null });
    await api.getCsrf();
    // Sign-up with e-mail on: 202, not signed in until the mailed code is confirmed.
    expect(await api.register("u@x.y", "password123")).toEqual({ email: "u@x.y", verification_required: true });
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    await expect(api.login("u@x.y", "password123")).rejects.toMatchObject({ status: 403, code: "E_EMAIL_UNVERIFIED" });
    await api.resendCode("u@x.y");
    expect(srv.state.outbox.filter((m) => m.kind === "verify")).toHaveLength(2);
    const verify = srv.state.outbox.at(-1)!;
    await expect(api.verifyEmail("u@x.y", "000000")).rejects.toMatchObject({ status: 400, code: "E_BAD_CODE" });
    expect(await api.verifyEmail("u@x.y", verify.code)).toEqual({ email: "u@x.y" });
    expect(((await api.me()) as Me).email).toBe("u@x.y");
    // Devices + synced pairings.
    srv.state.devices.set("d1", { id: "d1", name: "PC", platform: "linux", tray_version: "0.1", created_at: "t", last_seen_at: null, online: true, owner: "u@x.y" });
    expect(await api.listDevices()).toEqual([{ id: "d1", name: "PC", platform: "linux", tray_version: "0.1", created_at: "t", last_seen_at: null, online: true }]);
    expect((await api.renameDevice("d1", "Desk")).name).toBe("Desk");
    expect(await api.getPairings()).toBeNull();
    await api.putPairings({ timestamp: "2026-10-09T00:00:00Z", ciphertext: "cGFpcmluZ3M" });
    expect(await api.getPairings()).toEqual({ timestamp: "2026-10-09T00:00:00Z", ciphertext: "cGFpcmluZ3M" });
    await api.deletePairings();
    expect(await api.getPairings()).toBeNull();
    await api.putPairings({ timestamp: "2026-10-09T00:00:00Z", ciphertext: "x" });
    // Two-step sign-in.
    const setup = await api.totpSetup();
    expect(setup.otpauth_url).toContain(`secret=${setup.secret}`);
    await expect(api.totpEnable("000000")).rejects.toMatchObject({ status: 400, code: "E_BAD_CODE" });
    await api.totpEnable(totpCode(setup.secret));
    expect(((await api.me()) as Me).totp_enabled).toBe(true);
    await api.logout();
    await expect(api.login("u@x.y", "password123")).rejects.toMatchObject({ status: 401, code: "E_TOTP_REQUIRED" });
    await expect(api.login("u@x.y", "password123", undefined, "000000")).rejects.toMatchObject({ status: 401, code: "E_TOTP_INVALID" });
    await api.login("u@x.y", "password123", undefined, totpCode(setup.secret));
    await api.totpDisable("password123", totpCode(setup.secret));
    expect(((await api.me()) as Me).totp_enabled).toBe(false);
    // Password change: every device and the pairings blob are gone, this session stays.
    await api.changePassword("password123", "password456");
    expect(await api.listDevices()).toEqual([]);
    expect(await api.getPairings()).toBeNull();
    expect(((await api.me()) as Me).email).toBe("u@x.y");
    // Password reset by e-mail code: {email} → code by mail; {email, code, new_password} → 204, everything out.
    srv.state.devices.set("d2", { id: "d2", name: "PC", platform: "linux", tray_version: "0.1", created_at: "t", last_seen_at: null, online: true, owner: "u@x.y" });
    await api.passwordReset("u@x.y");
    const reset = srv.state.outbox.at(-1)!;
    expect(reset).toMatchObject({ to: "u@x.y", kind: "reset" });
    await expect(api.passwordResetConfirm("u@x.y", reset.code === "000000" ? "000001" : "000000", "password789")).rejects.toMatchObject({ status: 400, code: "E_BAD_CODE" });
    await api.passwordResetConfirm("u@x.y", reset.code, "password789");
    const confirmReq = srv.state.requests.filter((r) => r.path === "/api/auth/password-reset/confirm").at(-1)!;
    expect(Object.keys(confirmReq.body as object).sort()).toEqual(["code", "email", "new_password"]);
    await expect(api.me()).rejects.toMatchObject({ status: 401 }); // signed out everywhere
    await api.login("u@x.y", "password789");
    expect(await api.listDevices()).toEqual([]);
    await api.deleteDevice("d1").catch(() => undefined);
    await api.deleteAccount("password789");
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    const paths = srv.state.requests.map((r) => `${r.method} ${r.path}`);
    for (const p of [
      "GET /api/auth/csrf", "POST /api/auth/register", "POST /api/auth/verify-email", "POST /api/auth/resend-code", "POST /api/auth/login",
      "GET /api/auth/me", "POST /api/auth/logout", "POST /api/auth/change-password", "POST /api/auth/password-reset",
      "POST /api/auth/password-reset/confirm", "POST /api/auth/totp/setup", "POST /api/auth/totp/enable", "POST /api/auth/totp/disable",
      "GET /api/devices/", "PATCH /api/devices/d1", "DELETE /api/devices/d1", "GET /api/devices/pairings", "PUT /api/devices/pairings",
      "DELETE /api/devices/pairings", "DELETE /api/auth/account",
    ]) {
      expect(paths).toContain(p);
    }
  });

  it("wraps network failures and reads the csrftoken cookie from document.cookie", async () => {
    const api = createApi({ fetch: () => Promise.reject(new TypeError("Failed to fetch")) });
    await expect(api.me()).rejects.toMatchObject({ status: 0, code: "E_NETWORK" });
    (globalThis as { document?: unknown }).document = { cookie: "a=1; csrftoken=tok%20en; b=2" };
    expect(readCookie("csrftoken")).toBe("tok en");
    expect(readCookie("zzz")).toBeNull();
    delete (globalThis as { document?: unknown }).document;
  });

  it("an HTML error page never becomes the message; a plain-text reason does", async () => {
    const reply = (body: string, status: number) => () => Promise.resolve(new Response(body, { status }));
    const html = createApi({ fetch: reply('<!DOCTYPE html>\n<html lang="en"><title>403 Forbidden</title></html>', 403), getCsrfToken: () => "t" });
    await expect(html.logout()).rejects.toMatchObject({ status: 403, message: "HTTP 403" });
    const text = createApi({ fetch: reply("Service temporarily down", 503), getCsrfToken: () => "t" });
    await expect(text.logout()).rejects.toMatchObject({ status: 503, message: "Service temporarily down" });
  });
});

describe("secure context", () => {
  it("the app needs WebCrypto and a secure context (https://, or localhost)", async () => {
    const { isSecureEnough } = await import("../src/app/InsecureContext");
    expect(isSecureEnough({ isSecureContext: true, crypto: { subtle: {} } })).toBe(true);
    expect(isSecureEnough({ isSecureContext: false, crypto: { subtle: undefined } })).toBe(false);
    expect(isSecureEnough({ isSecureContext: true, crypto: {} })).toBe(false);
    expect(isSecureEnough({ crypto: { subtle: {} } })).toBe(true); // Node: no isSecureContext, WebCrypto present
  });
});
