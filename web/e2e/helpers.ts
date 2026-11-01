// E2E helpers: start/stop headless trays (real Go binary) and read their pairing code; read the
// 6-digit codes the server mails to a directory (EMAIL_URL=file://…, see scripts/e2e.sh).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, TestInfo } from "@playwright/test";

export { totpCode } from "../tests/helpers/totp";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../..");
const DEVSERVER = join(ROOT, "scripts/devserver.sh");
const SERVER_URL = process.env.E2E_SERVER_URL ?? "http://localhost:8080";
/** Where the server writes each mail as one file (set by scripts/e2e.sh). */
export const MAIL_DIR = process.env.E2E_MAIL_DIR ?? "";

export interface Tray {
  dir: string;
  stop(): void;
  log(): string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function startTray(label: string): Tray {
  const dir = mkdtempSync(join(tmpdir(), `tunnelio-e2e-${label}-`));
  execFileSync(DEVSERVER, ["tray-start", dir, SERVER_URL], { stdio: "pipe" });
  return {
    dir,
    stop: () => {
      try {
        execFileSync(DEVSERVER, ["tray-stop", dir], { stdio: "pipe" });
      } catch {
        /* already stopped */
      }
    },
    log: () => {
      try {
        return readFileSync(join(dir, "tray.log"), "utf8");
      } catch {
        return "";
      }
    },
  };
}

/**
 * Waits for `PAIRING CODE: XXXX-XXXX-XXXX` in the tray log (the headless tray prints it when unpaired,
 * and a new one after it was revoked). With `after`, waits for a code that differs from it.
 */
export async function waitForPairingCode(tray: Tray, opts: { after?: string; timeoutMs?: number } = {}): Promise<string> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const codes = [...tray.log().matchAll(/PAIRING CODE: ([0-9A-Z-]{14})/g)].map((m) => m[1]);
    const code = codes[codes.length - 1];
    if (code && code !== opts.after) return code;
    await sleep(250);
  }
  throw new Error(`no ${opts.after ? "new " : ""}pairing code in ${tray.dir}/tray.log:\n${tray.log()}`);
}

export async function waitForLog(tray: Tray, pattern: RegExp, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(tray.log())) return;
    await sleep(250);
  }
  throw new Error(`pattern ${pattern} not found in tray log:\n${tray.log()}`);
}

/**
 * The 6-digit code of the newest mail to `email` written after `since` (Django's file backend
 * writes one file per message; the body carries the line `Code: 123456`).
 */
export async function waitForMailCode(email: string, since: number, timeoutMs = 30_000): Promise<string> {
  if (!MAIL_DIR) throw new Error("E2E_MAIL_DIR is not set (run through scripts/e2e.sh)");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = readdirSync(MAIL_DIR)
      .map((f) => join(MAIL_DIR, f))
      .filter((f) => statSync(f).mtimeMs >= since - 1000)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (!new RegExp(`^To: .*${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "im").test(text)) continue;
      const code = /^Code: (\d{6})/m.exec(text)?.[1];
      if (code) return code;
    }
    await sleep(250);
  }
  throw new Error(`no mail with a code for ${email} in ${MAIL_DIR}`);
}

let shotIndex = 0;

/** Full-page screenshot under e2e/screenshots/<project>/<nn>-<name>.png — the visual review artefacts. */
export async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  shotIndex += 1;
  const file = join(HERE, "screenshots", info.project.name, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
}

export function uniqueEmail(prefix = "e2e"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

/** One password: signs in on every device; ≥ 12 characters. */
export const PASSWORD = "correct horse battery staple";
export const NEW_PASSWORD = "staple battery horse correct 2";
export const RESET_PASSWORD = "battery staple correct horse 3";
export const MODEL = process.env.E2E_MODEL ?? "qwen2.5:0.5b";
/** Vision model for the image step; the step is skipped (annotated) when the device does not list it. */
export const VISION_MODEL = process.env.E2E_VISION_MODEL ?? "moondream";

// Generated fixtures (PNG, PDF, .docx, .xlsx) shared with the unit tests.
export { makeDocx, makePdf, makeXlsx, solidPng } from "../tests/helpers/doc-fixtures";

/**
 * Fake Web Speech engine for the dictation step: `start()` emits one interim result ("hello") and
 * then a final one ("hello world"), shaped like real `SpeechRecognitionEvent`s. Registered with
 * `page.addInitScript` before the first navigation.
 */
export function fakeSpeechRecognitionScript(): string {
  return `(() => {
    class FakeSpeechRecognition {
      constructor() { this.continuous = false; this.interimResults = false; this.lang = ""; this.onresult = null; this.onerror = null; this.onend = null; this._timers = []; }
      _emit(transcript, isFinal) { this.onresult && this.onresult({ resultIndex: 0, results: [{ isFinal, length: 1, 0: { transcript, confidence: 0.9 } }] }); }
      start() {
        this._timers.push(setTimeout(() => this._emit("hello", false), 100));
        this._timers.push(setTimeout(() => this._emit("hello world", true), 200));
      }
      stop() { for (const t of this._timers) clearTimeout(t); this._timers = []; setTimeout(() => this.onend && this.onend(), 0); }
      abort() { this.stop(); }
    }
    window.SpeechRecognition = FakeSpeechRecognition;
    window.__fakeSpeech = true;
  })();`;
}
