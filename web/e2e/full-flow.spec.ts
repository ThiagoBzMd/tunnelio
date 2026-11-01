// The whole product, end to end, against real server + real Go tray + real Ollama (rev. 1.3):
// register → confirm the mailed code → pair (SPAKE2) → models → chat (streaming) → reload → vision
// (image attach, when a vision model is installed) → dictation (fake speech engine, desktop) → a
// second browser signs in and is already paired (synced pairings) → two-step sign-in on/off →
// documents (PDF with a figure to the vision model, .xlsx + .docx to the text model, a document too
// long for the model) → password change disconnects the computer, pair again → offline computer →
// deep-link pairing with a second tray → forgot password by e-mail code → pair again → Settings →
// Conversations: counts, Delete all. The server mails to a directory and, when scripts/e2e.sh turns
// the bot check on (E2E_BOT_CHECK=1), runs it with the always-pass test keys. Every screen state is captured to
// e2e/screenshots/<project>/.

import { expect, test, type Page } from "@playwright/test";
import {
  MODEL,
  NEW_PASSWORD,
  PASSWORD,
  RESET_PASSWORD,
  VISION_MODEL,
  fakeSpeechRecognitionScript,
  makeDocx,
  makePdf,
  makeXlsx,
  shot,
  solidPng,
  startTray,
  totpCode,
  uniqueEmail,
  waitForLog,
  waitForMailCode,
  waitForPairingCode,
  type Tray,
} from "./helpers";

test.describe.configure({ mode: "serial" });

let trayA: Tray | null = null;
let trayB: Tray | null = null;

test.afterAll(() => {
  trayA?.stop();
  trayB?.stop();
});

/**
 * Two-step codes: the server accepts each code once (anti-replay per 30 s step), so every code the
 * test uses comes from a step later than the previous one — waiting for the next step when needed.
 */
let lastTotpStep = 0;
async function freshTotp(secret: string): Promise<string> {
  const step = () => Math.floor(Date.now() / 30_000);
  while (step() <= lastTotpStep) await new Promise((r) => setTimeout(r, 500));
  lastTotpStep = step();
  return totpCode(secret);
}

/**
 * Submit the reset form and classify what happened. The request shares the server's per-IP `login`
 * throttle (5/min) with the sign-ins this flow just made, so a throttled attempt is waited out and
 * sent again — the app shows the server's message and keeps the form, exactly as a user would see.
 */
async function submitReset(page: Page): Promise<"devices" | "login" | "bad_code"> {
  for (let attempt = 0; ; attempt++) {
    await page.getByTestId("submit").click();
    const outcome = await Promise.race([
      page.getByTestId("devices-screen").waitFor({ state: "visible", timeout: 60_000 }).then(() => "devices" as const, () => "timeout" as const),
      page.getByTestId("login-notice").waitFor({ state: "visible", timeout: 60_000 }).then(() => "login" as const, () => "timeout" as const),
      page.getByTestId("form-error").filter({ hasText: /wrong or expired|errado ou expirado/i }).waitFor({ state: "visible", timeout: 60_000 }).then(() => "bad_code" as const, () => "timeout" as const),
      page.getByTestId("form-error").filter({ hasText: /throttled/i }).waitFor({ state: "visible", timeout: 60_000 }).then(() => "throttled" as const, () => "timeout" as const),
    ]);
    if (outcome === "throttled" && attempt < 4) {
      const text = (await page.getByTestId("form-error").textContent()) ?? "";
      await page.waitForTimeout((Number(/(\d+) seconds?/.exec(text)?.[1] ?? 30) + 1) * 1000);
      continue;
    }
    if (outcome === "timeout" || outcome === "throttled") throw new Error(`reset submit did not settle (${outcome})`);
    return outcome;
  }
}

/** The bot check's test keys pass on their own a moment after the widget renders: the submit waits for it. */
async function submitWhenReady(page: Page) {
  const submit = page.getByTestId("submit");
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await submit.click();
}

async function register(page: Page, email: string, info: Parameters<typeof shot>[1]) {
  await page.goto("/register");
  await page.getByTestId("email").fill(email);
  await page.getByTestId("password").fill(PASSWORD);
  await page.getByTestId("confirm").fill(PASSWORD);
  const since = Date.now();
  await submitWhenReady(page);
  // E-mail verification: the code arrives in the mail directory.
  await expect(page.getByTestId("verify-form")).toBeVisible({ timeout: 30_000 });
  await shot(page, info, "verify-email");
  await page.getByTestId("verify-code").fill(await waitForMailCode(email, since));
  await page.getByTestId("submit").click();
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
}

/**
 * Sign in; `totp` is a function so the code is computed right before it is needed. Waits out the
 * server's per-IP login throttle (both projects run back to back on 127.0.0.1).
 */
async function login(page: Page, email: string, password: string, totp?: () => Promise<string>, info?: Parameters<typeof shot>[1]) {
  await page.goto("/login");
  await expect(page.getByTestId("login-form")).toBeVisible();
  await page.getByTestId("email").fill(email);
  await page.getByTestId("password").fill(password);
  for (let attempt = 0; ; attempt++) {
    await submitWhenReady(page);
    const outcome = await Promise.race([
      page.getByTestId("login-form").waitFor({ state: "hidden", timeout: 30_000 }).then(() => "ok" as const, () => "timeout" as const),
      page.getByTestId("form-error").filter({ hasText: /throttled/i }).waitFor({ state: "visible", timeout: 30_000 }).then(() => "throttled" as const, () => "timeout" as const),
      page.getByTestId("totp-code").waitFor({ state: "visible", timeout: 30_000 }).then(() => "totp" as const, () => "timeout" as const),
    ]);
    if (outcome === "ok") break;
    if (outcome === "totp") {
      if (!totp) throw new Error("two-step code asked but none provided");
      if (info) await shot(page, info, "login-two-step");
      // The code step is another login request: it can hit the same per-IP throttle.
      for (let codeAttempt = 0; ; codeAttempt++) {
        await page.getByTestId("totp-code").fill(await totp());
        await submitWhenReady(page);
        const codeOutcome = await Promise.race([
          page.getByTestId("login-form").waitFor({ state: "hidden", timeout: 30_000 }).then(() => "ok" as const, () => "timeout" as const),
          page.getByTestId("form-error").filter({ hasText: /throttled/i }).waitFor({ state: "visible", timeout: 30_000 }).then(() => "throttled" as const, () => "timeout" as const),
        ]);
        if (codeOutcome === "ok") break;
        if (codeOutcome !== "throttled" || codeAttempt >= 3) throw new Error(`two-step login did not complete (${codeOutcome})`);
        const text = (await page.getByTestId("form-error").textContent()) ?? "";
        await page.waitForTimeout((Number(/(\d+) seconds?/.exec(text)?.[1] ?? 30) + 1) * 1000);
        if (!(await page.getByTestId("totp-code").isVisible())) {
          // The form went back to the password step: submit it again, then the code.
          await submitWhenReady(page);
          await page.getByTestId("totp-code").waitFor({ state: "visible", timeout: 30_000 });
        }
      }
      break;
    }
    if (outcome !== "throttled" || attempt >= 3) throw new Error(`login did not complete (${outcome})`);
    const text = (await page.getByTestId("form-error").textContent()) ?? "";
    const seconds = Number(/(\d+) seconds?/.exec(text)?.[1] ?? 30);
    await page.waitForTimeout((seconds + 1) * 1000);
  }
  // The router may land on the screen the sign-out came from (its `from` state survives the reload).
  await page.goto("/");
  await expect(page.getByTestId("chat-screen")).toBeVisible({ timeout: 30_000 });
}

async function logout(page: Page) {
  await openSidebar(page);
  await page.locator('[data-testid="account-menu"]:visible').click();
  // Desktop: the account menu. Phone: the initials open Settings, "Sign out" at the end.
  await page.getByTestId("menu-logout").or(page.getByTestId("settings-logout")).click();
  await expect(page.getByTestId("login-form")).toBeVisible();
}

/** Flips light/dark through the system colour scheme (the theme setting defaults to "system"). */
let darkScheme = false;
async function toggleTheme(page: Page) {
  darkScheme = !darkScheme;
  await page.emulateMedia({ colorScheme: darkScheme ? "dark" : "light" });
  await expect(page.locator("html")).toHaveClass(darkScheme ? /dark/ : /^(?!.*dark).*$/);
  await page.waitForTimeout(300); // let the colour transitions finish before a screenshot
}

/**
 * Opens the model menu and waits until it is really open. Right after a selection the previous
 * menu is still playing its closing animation: it is visible (data-state="closed"), a tap on the
 * trigger is swallowed, and an item clicked in it vanishes mid-click. So: wait for the old menu
 * to be gone, click, and require data-state="open"; retry when the tap was swallowed.
 */
async function openModelMenu(page: Page) {
  // Desktop: a dropdown menu. Phone: a sheet from the bottom (same items and test ids).
  for (let attempt = 0; attempt < 15; attempt++) {
    await page.locator('[role="menu"], [data-testid="model-sheet"]').first().waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
    await page.getByTestId("model-picker").click();
    try {
      await page.locator('[role="menu"][data-state="open"], [data-testid="model-sheet"][data-state="open"]').first().waitFor({ state: "visible", timeout: 2_000 });
      return;
    } catch {
      /* the tap was swallowed: try again */
    }
  }
  throw new Error("the model menu did not open");
}

/** Closes Settings: on a phone, from one of its pages, back to the list first. */
async function closeSettings(page: Page) {
  const back = page.getByTestId("settings-back");
  if (await back.isVisible()) await back.click();
  await page.getByTestId("settings-close").click();
}

async function openSidebar(page: Page) {
  // The settings window is modal: close it first (and let a closing one finish its animation).
  if (await page.locator('[data-testid="settings-dialog"][data-state="open"]').isVisible()) await closeSettings(page);
  await page.getByTestId("settings-dialog").waitFor({ state: "detached", timeout: 5_000 });
  // Mobile: the sidebar is a sheet; when it is already open its overlay covers the toggle.
  if (await page.locator('[role="dialog"][data-side="left"][data-state="open"]').isVisible()) return;
  const toggle = page.getByTestId("sidebar-toggle");
  if (await toggle.isVisible()) await toggle.click();
}

async function pairWithCode(page: Page, code: string) {
  await page.getByTestId("pair-code").fill(code);
  await page.getByTestId("pair-submit").click();
  await expect(page.getByTestId("pair-success")).toBeVisible({ timeout: 30_000 });
}

/** Pair the (unpaired) tray from the devices screen and wait for its card. */
async function pairFromDevices(page: Page, tray: Tray, after?: string): Promise<string> {
  const code = await waitForPairingCode(tray, after !== undefined ? { after } : {});
  await page.goto("/devices");
  await page.getByTestId("add-device-button").click();
  await expect(page.getByTestId("pair-dialog")).toBeVisible();
  await pairWithCode(page, code);
  await page.getByTestId("pair-close").click();
  await expect(page.getByTestId("pair-dialog")).toBeHidden();
  await expect(page.locator('[data-testid="device-card"][data-paired="true"]').first()).toBeVisible({ timeout: 30_000 });
  return code;
}

test("full flow", async ({ page, browser }, info) => {
  const email = uniqueEmail();
  const desktop = info.project.name === "desktop";
  // Dictation uses the browser's speech engine; headless Chromium has none, so inject a fake.
  if (desktop) await page.addInitScript(fakeSpeechRecognitionScript());

  // ── auth: one password, e-mail confirmed by code ────────────────────────
  await page.goto("/login");
  await expect(page.getByTestId("login-form")).toBeVisible();
  if (process.env.E2E_BOT_CHECK === "1") await expect(page.getByTestId("bot-check")).toBeVisible();
  await shot(page, info, "login");
  await page.getByTestId("link-register").click();
  await expect(page.getByTestId("register-form")).toBeVisible();
  await shot(page, info, "register");
  await register(page, email, info);
  await expect(page.getByTestId("chat-screen")).toBeVisible();
  await shot(page, info, "chat-no-device");

  // ── devices: pair with a fresh headless tray ────────────────────────────
  trayA = startTray("a");
  let codeA = await waitForPairingCode(trayA);
  await page.goto("/devices");
  await expect(page.getByTestId("add-device")).toBeVisible();
  await shot(page, info, "devices-empty");
  await page.getByTestId("add-device-button").click();
  await expect(page.getByTestId("pair-dialog")).toBeVisible();
  await page.getByTestId("pair-code").fill("bad code");
  await shot(page, info, "pair-dialog");
  await pairWithCode(page, codeA);
  await shot(page, info, "pair-success");
  await page.getByTestId("pair-close").click();
  await expect(page.getByTestId("pair-dialog")).toBeHidden();
  const card = page.getByTestId("device-card").first();
  await expect(card).toHaveAttribute("data-paired", "true");
  await expect(card).toHaveAttribute("data-online", "true");
  await waitForLog(trayA, /PAIRED device_id=/);
  await shot(page, info, "devices-paired");

  // rename
  await page.getByTestId("device-rename").click();
  await page.getByTestId("device-name-input").fill("Desk PC");
  await page.getByTestId("device-name-input").press("Enter");
  await expect(page.getByTestId("device-name")).toHaveText("Desk PC");

  // ── models ──────────────────────────────────────────────────────────────
  await page.goto("/models");
  await expect(page.getByTestId("model-list").locator(`[data-name="${MODEL}"]`)).toBeVisible({ timeout: 30_000 });
  await shot(page, info, "models");
  await page.getByTestId("pull-input").fill("not a valid name");
  await expect(page.getByTestId("pull-submit")).toBeDisabled();
  await page.getByTestId("pull-input").fill("");
  // The Ollama library (server relay; the bundled snapshot here): search; each size downloads with
  // one click (not clicked here: no real downloads in the test) and says how big it is; an
  // installed size shows as such.
  await expect(page.getByTestId("catalog-list")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("catalog-search").fill("llama3.2");
  const libraryEntry = page.locator('[data-testid="catalog-item"][data-name="llama3.2"]');
  await expect(libraryEntry).toBeVisible();
  await expect(libraryEntry.locator("[data-maker]")).toHaveAttribute("data-maker", "meta");
  const size3b = libraryEntry.locator('[data-testid="catalog-size"][data-target="llama3.2:3b"]');
  await expect(size3b).toHaveAttribute("data-state", "available");
  await expect(size3b.getByTestId("catalog-size-bytes")).toHaveText(/^· [\d.,]+ GB$/);
  await shot(page, info, "models-catalog");
  await page.getByTestId("catalog-search").fill("qwen2.5");
  await expect(page.locator(`[data-testid="catalog-size"][data-target="${MODEL}"]`)).toHaveAttribute("data-state", "installed");
  await page.getByTestId("catalog-search").fill("");

  // ── chat with streaming ─────────────────────────────────────────────────
  await page.goto("/");
  await expect(page.getByTestId("chat-empty")).toBeVisible();
  await openModelMenu(page);
  // The menu: installed models, then the most popular library models not installed yet (folded
  // under "Other models" on a phone).
  if (!desktop) await page.getByTestId("model-others").click();
  await expect(page.locator('[data-testid^="catalog-option-"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid^="quick-download-"]').first()).toContainText(/\d [MG]B$/);
  await page.locator('[data-testid^="quick-download-"]').first().scrollIntoViewIfNeeded();
  await shot(page, info, "model-menu");
  await page.getByTestId(`model-option-${MODEL}`).click();
  await expect(page.getByTestId("composer-input")).toBeEnabled({ timeout: 30_000 });
  // Per-model settings: kept in the browser, sent as `options` (the tray validates the ranges).
  await openModelMenu(page);
  await page.getByTestId("model-options").click();
  await expect(page.getByTestId("model-options-dialog")).toBeVisible();
  await page.getByTestId("model-option-temperature").fill("0.2");
  await page.getByTestId("model-option-seed").fill("7");
  await shot(page, info, "model-options");
  await page.getByTestId("model-options-save").click();
  await expect(page.getByTestId("model-options-dialog")).toBeHidden();
  await expect(page.getByTestId("model-picker")).toHaveAttribute("data-custom", "true");
  await shot(page, info, "chat-empty");
  // The send button only exists once there is something to send; the dark theme gets its own shot.
  await expect(page.getByTestId("send")).toHaveCount(0);
  await page.getByTestId("composer-input").fill("Answer with one word: hi");
  await expect(page.getByTestId("send")).toBeVisible();
  await toggleTheme(page);
  await shot(page, info, "chat-empty-dark");
  await toggleTheme(page);
  await page.getByTestId("send").click();
  await expect(page.getByTestId("message-user")).toBeVisible();
  await expect(page.getByTestId("message-assistant")).toBeVisible();
  await shot(page, info, "chat-streaming");
  await expect(page.getByTestId("message-stats")).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await shot(page, info, "chat-done");
  const convUrl = page.url();
  // "Default" forgets the model's settings.
  await openModelMenu(page);
  await page.getByTestId("model-options").click();
  await expect(page.getByTestId("model-options-dialog")).toBeVisible();
  await page.getByTestId("model-options-default").click();
  await expect(page.getByTestId("model-options-dialog")).toBeHidden();
  await expect(page.getByTestId("model-picker")).toHaveAttribute("data-custom", "false");

  // second turn keeps context in the same conversation
  await page.getByTestId("composer-input").fill("Agora diga: tchau");
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByTestId("message-assistant")).toHaveCount(2);
  await expect(page.getByTestId("message-stats")).toHaveCount(2, { timeout: 60_000 });

  // sidebar lists it, reload restores it from the device
  await openSidebar(page);
  // Mobile renders the sidebar twice (desktop aside hidden by CSS + sheet): count visible items only.
  await expect(page.locator('[data-testid="conversation-item"]:visible')).toHaveCount(1);
  // The "…" menu is always visible (touch screens have no hover) and long titles never make the
  // list scroll sideways.
  const convList = page.locator('[data-testid="conversation-list"]:visible');
  await expect(convList.locator('[data-testid="conversation-menu"]')).toHaveCSS("opacity", "1");
  const listDims = await convList.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(listDims.scroll).toBeLessThanOrEqual(listDims.client);
  // Pin it: it moves to the "Pinned" section at the top (this browser only).
  await convList.locator('[data-testid="conversation-menu"]').first().click();
  await page.getByTestId("conversation-pin").click();
  await expect(convList.getByTestId("conversation-section-pinned").getByTestId("conversation-item")).toHaveCount(1);
  await shot(page, info, "sidebar");
  if (desktop) {
    // The account menu: settings, language, the "Learn more" submenu with the keyboard shortcuts.
    await convList.locator("xpath=..").getByTestId("account-menu").click();
    await expect(page.getByTestId("menu-settings")).toBeVisible();
    await shot(page, info, "account-menu");
    await page.getByTestId("menu-learn-more").click();
    await expect(page.getByTestId("menu-shortcuts")).toBeVisible();
    await shot(page, info, "account-menu-learn-more");
    await page.getByTestId("menu-shortcuts").click();
    await expect(page.getByTestId("shortcuts-dialog")).toBeVisible();
    await shot(page, info, "shortcuts");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("shortcuts-dialog")).toBeHidden();
    await openSidebar(page);
    await page.locator('[data-testid="account-menu"]:visible').click();
    await page.getByTestId("menu-language").click();
    await expect(page.getByTestId("language-dialog")).toBeVisible();
    await shot(page, info, "language");
    await page.getByTestId("language-option-pt-BR").click();
    await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
    await expect(page.getByTestId("composer-input")).toHaveAttribute("placeholder", "Mensagem…");
    await openSidebar(page);
    await page.locator('[data-testid="account-menu"]:visible').click();
    await page.getByTestId("menu-language").click();
    await page.getByTestId("language-option-auto").click(); // back to the browser's language (English)
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    // "What should Tunnelio call you?": kept sealed in the account, shown in the greeting and the sidebar.
    await openSidebar(page);
    await page.locator('[data-testid="account-menu"]:visible').click();
    await page.getByTestId("menu-settings").click();
    // General → About: the licence, the source of this build and the third-party licences (AGPL-3.0).
    await expect(page.getByTestId("license-row")).toContainText("GNU AGPL-3.0-only");
    await expect(page.getByTestId("license-text-link")).toHaveAttribute("href", "/LICENSE.txt");
    await expect(page.getByTestId("source-code-link")).toHaveAttribute("href", /^https:\/\/github\.com\/ThiagoBzMd\/tunnelio/);
    await expect(page.getByTestId("third-party-link")).toHaveAttribute("href", "/third-party-licenses.txt");
    await page.getByTestId("license-row").scrollIntoViewIfNeeded();
    await shot(page, info, "settings-license");
    await page.getByTestId("settings-tab-account").click();
    await expect(page.getByTestId("computer-row")).toHaveCount(1);
    await expect(page.getByTestId("session-row")).not.toHaveCount(0);
    await page.getByTestId("display-name-input").fill("Ana");
    await page.getByTestId("display-name-input").press("Enter");
    await shot(page, info, "settings-account");
    await page.getByTestId("settings-close").click();
    await expect(page.locator('[data-testid="account-menu"]').first()).toContainText("Ana");
  } else {
    // A phone: the initials open Settings, a list of pages; "i" holds the version and the public
    // pages; the language is a row of the list.
    await convList.locator("xpath=..").getByTestId("account-menu").click();
    await expect(page.getByTestId("settings-account-card")).toBeVisible();
    await page.waitForTimeout(400); // the drawer closing and the page opening
    await shot(page, info, "settings-phone");
    await page.getByTestId("settings-info").click();
    await expect(page.getByTestId("settings-info-version")).toBeVisible();
    await expect(page.getByTestId("license-notice")).toContainText("GNU AGPL-3.0-only");
    await expect(page.getByTestId("license-text-link")).toHaveAttribute("href", "/LICENSE.txt");
    await expect(page.getByTestId("third-party-link")).toHaveAttribute("href", "/third-party-licenses.txt");
    await page.waitForTimeout(300);
    await shot(page, info, "settings-info");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-info-version")).toBeHidden();
    await page.getByTestId("language-button").click();
    await expect(page.getByTestId("language-dialog")).toBeVisible();
    await shot(page, info, "language");
    await page.getByTestId("language-option-pt-BR").click();
    await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
    await expect(page.getByTestId("composer-input")).toHaveAttribute("placeholder", "Mensagem…");
    await page.getByTestId("language-button").click();
    await page.getByTestId("language-option-auto").click(); // back to the browser's language (English)
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    // "What should Tunnelio call you?", the computers and the sessions: one page each.
    await page.getByTestId("settings-page-computers").click();
    await expect(page.getByTestId("computer-row")).toHaveCount(1);
    await shot(page, info, "settings-computers");
    await page.getByTestId("settings-back").click();
    await page.getByTestId("settings-page-sessions").click();
    await expect(page.getByTestId("session-row")).not.toHaveCount(0);
    await page.getByTestId("settings-back").click();
    await page.getByTestId("settings-page-profile").click();
    await page.getByTestId("display-name-input").fill("Ana");
    await page.getByTestId("display-name-input").press("Enter");
    await shot(page, info, "settings-account");
    await page.getByTestId("settings-back").click();
    await expect(page.getByTestId("settings-account-card")).toContainText("Ana");
    await page.getByTestId("settings-close").click();
    await expect(page.locator('[data-testid="account-menu"]').first()).toContainText("Ana");
  }
  if (desktop) {
    // Hide the sidebar; hovering its button shows it floating; a click pins it again.
    await page.getByTestId("sidebar-collapse").click();
    await expect(page.getByTestId("sidebar-desktop")).toHaveCount(0);
    // The floating panel opens over the button, its own sidebar button right under the pointer.
    await page.getByTestId("sidebar-toggle").hover({ force: true });
    await expect(page.getByTestId("sidebar-peek")).toBeVisible();
    await page.mouse.move(120, 300); // inside the panel: it stays
    await page.waitForTimeout(400);
    await expect(page.getByTestId("sidebar-peek")).toBeVisible();
    await shot(page, info, "sidebar-peek");
    await page.getByTestId("sidebar-peek").getByTestId("sidebar-collapse").click();
    await expect(page.getByTestId("sidebar-desktop")).toBeVisible();
    await expect(page.getByTestId("sidebar-peek")).toHaveCount(0);
  }
  await page.goto(convUrl);
  await expect(page.getByTestId("message-user")).toHaveCount(2, { timeout: 30_000 });
  await shot(page, info, "chat-reloaded");

  // ── anonymous chat: the computer writes nothing, the sidebar does not list it ───────────
  await page.goto("/");
  await expect(page.getByTestId("chat-empty")).toBeVisible();
  const ghost = page.getByTestId("incognito-toggle");
  await expect(ghost).toBeEnabled({ timeout: 30_000 }); // device_info must advertise "incognito"
  await ghost.click();
  await expect(page.getByTestId("chat-incognito")).toBeVisible();
  await expect(page.getByTestId("incognito-bar")).toBeVisible();
  await expect(page.getByTestId("incognito-hint")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeEnabled({ timeout: 30_000 });
  await shot(page, info, "chat-incognito");
  await page.getByTestId("composer-input").fill("Answer with one word: secret");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("message-assistant")).toBeVisible();
  await expect(page.getByTestId("message-stats")).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await shot(page, info, "chat-incognito-done");
  await page.getByTestId("incognito-exit").click();
  await expect(page.getByTestId("incognito-bar")).toHaveCount(0);
  await expect(page.getByTestId("chat-greeting")).toBeVisible();
  await openSidebar(page);
  await expect(page.locator('[data-testid="conversation-item"]:visible')).toHaveCount(1); // only the normal chat
  await page.keyboard.press("Escape");

  // ── vision: attach a generated red square to a vision model (skipped when not installed) ──
  await page.goto("/");
  await expect(page.getByTestId("chat-empty")).toBeVisible();
  await openModelMenu(page);
  await expect(page.getByTestId(`model-option-${MODEL}`)).toBeVisible({ timeout: 30_000 }); // list loaded
  const visionOption = page.locator(`[data-testid="model-option-${VISION_MODEL}"], [data-testid="model-option-${VISION_MODEL}:latest"]`).first();
  if ((await visionOption.count()) === 0) {
    info.annotations.push({ type: "skip", description: `vision step skipped: "${VISION_MODEL}" is not installed on the device (E2E_VISION_MODEL)` });
    await page.keyboard.press("Escape");
  } else {
    await visionOption.click();
    await expect(page.getByTestId("composer-input")).toBeEnabled({ timeout: 30_000 });
    const attach = page.getByTestId("attach-image");
    let imagesReady = true;
    try {
      // Needs device_info.capabilities "images" (tray) and model_info.capabilities "vision" (show_model).
      // (The button itself is always enabled: documents work with every model.)
      await expect(attach).toHaveAttribute("data-images", "enabled", { timeout: 30_000 });
    } catch {
      imagesReady = false;
    }
    if (!imagesReady) {
      info.annotations.push({ type: "skip", description: "vision step skipped: the tray or the model does not advertise image support" });
    } else {
      await page.getByTestId("attach-input").setInputFiles({ name: "red-square.png", mimeType: "image/png", buffer: solidPng(64, [255, 0, 0]) });
      await expect(page.getByTestId("attachment")).toHaveCount(1);
      // moondream answers "Describe this image." reliably; colour questions sometimes come back empty.
      await page.getByTestId("composer-input").fill("Describe this image.");
      await shot(page, info, "chat-image-attached");
      await page.getByTestId("send").click();
      await expect(page.getByTestId("message-user")).toBeVisible();
      await expect(page.getByTestId("message-image")).toBeVisible();
      await expect(page.getByTestId("attachment")).toHaveCount(0);
      await expect(page.getByTestId("message-stats")).toBeVisible({ timeout: 120_000 }); // first load of the vision model
      const reply = page.getByTestId("message-assistant").locator(".markdown");
      await expect(reply).toBeVisible(); // an empty reply renders no markdown node at all
      await expect(reply).not.toBeEmpty();
      await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
      await shot(page, info, "chat-image-reply");
      // Reload: the image comes back from the device's history (history_get images[]).
      const visionUrl = page.url();
      await page.goto(visionUrl);
      await expect(page.getByTestId("message-image")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("message-assistant")).toBeVisible();
    }
    // Back to the text model for the rest of the flow.
    await page.goto("/");
    await openModelMenu(page);
    await page.getByTestId(`model-option-${MODEL}`).click();
    await expect(page.getByTestId("composer-input")).toBeEnabled({ timeout: 30_000 });
  }

  // ── dictation through the (fake) browser speech engine ──────────────────
  if (desktop) {
    await page.goto("/");
    await expect(page.getByTestId("composer-input")).toBeEnabled({ timeout: 30_000 });
    const dictate = page.getByTestId("dictate");
    await expect(dictate).toBeVisible();
    await dictate.click();
    await expect(dictate).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("dictation-hint")).toBeVisible(); // first use: the vendor caveat
    await expect(page.getByTestId("composer-input")).toHaveValue("hello world", { timeout: 10_000 });
    await shot(page, info, "chat-dictation");
    await dictate.click();
    await expect(dictate).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("composer-input")).toHaveValue("hello world");
    await page.getByTestId("send").click();
    await expect(page.getByTestId("message-user")).toHaveText("hello world");
    await expect(page.getByTestId("message-stats")).toBeVisible({ timeout: 60_000 });
  }

  // ── documents: PDF with a figure → vision model (text as text, the figure page as one image) ──
  const visionAvailable = await (async () => {
    await page.goto("/");
    await openModelMenu(page);
    await expect(page.getByTestId(`model-option-${MODEL}`)).toBeVisible({ timeout: 30_000 });
    const opt = page.locator(`[data-testid="model-option-${VISION_MODEL}"], [data-testid="model-option-${VISION_MODEL}:latest"]`).first();
    if ((await opt.count()) === 0) {
      await page.keyboard.press("Escape");
      return false;
    }
    await opt.click();
    return true;
  })();
  if (!visionAvailable) {
    info.annotations.push({ type: "skip", description: `PDF-with-figure step skipped: "${VISION_MODEL}" is not installed` });
  } else {
    await expect(page.getByTestId("attach-image")).toHaveAttribute("data-images", "enabled", { timeout: 30_000 });
    const pdf = Buffer.from(await makePdf([{ text: ["Quarterly note zebrafruit", "Revenue grew in March."] }, { image: [220, 30, 30] }]));
    await page.getByTestId("attach-input").setInputFiles({ name: "report.pdf", mimeType: "application/pdf", buffer: pdf });
    const draft = page.getByTestId("draft-document");
    await expect(draft).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    await expect(draft).toContainText("2 pages");
    await page.getByTestId("composer-input").fill("Describe this document.");
    await shot(page, info, "chat-pdf-attached");
    await page.getByTestId("send").click();
    const sent = page.getByTestId("message-user").last();
    await expect(sent.getByTestId("document-chip")).toContainText("report.pdf");
    await expect(sent.getByTestId("message-image")).toHaveCount(1); // page 2 only: page 1 is text
    await expect(sent.getByTestId("message-user-text")).toHaveText("Describe this document.");
    await expect(page.getByTestId("message-stats").last()).toBeVisible({ timeout: 120_000 });
    await shot(page, info, "chat-pdf-reply");
    // Reload: the chip comes back from the computer's history and still expands to the text.
    const pdfUrl = page.url();
    await page.goto(pdfUrl);
    const reloaded = page.getByTestId("message-user").first();
    await expect(reloaded.getByTestId("document-chip")).toBeVisible({ timeout: 30_000 });
    await expect(reloaded.getByTestId("message-image")).toHaveCount(1);
    await reloaded.getByTestId("document-chip-toggle").click();
    await expect(reloaded.getByTestId("document-text")).toContainText("zebrafruit");
    await shot(page, info, "chat-pdf-reloaded");
    // Regression: a PDF attached inside a conversation that already has messages used to be closed
    // before its pages were drawn (only the text went). The figure page must go as an image here too.
    await page.getByTestId("attach-input").setInputFiles({ name: "again.pdf", mimeType: "application/pdf", buffer: pdf });
    await expect(page.getByTestId("draft-document")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
    await page.getByTestId("composer-input").fill("And this one?");
    await page.getByTestId("send").click();
    const again = page.getByTestId("message-user").last();
    await expect(again.getByTestId("document-chip")).toContainText("again.pdf");
    await expect(again.getByTestId("message-image")).toHaveCount(1);
    await expect(page.getByTestId("message-stats")).toHaveCount(2, { timeout: 120_000 });
  }

  // ── documents: a spreadsheet and a Word file → the text model ───────────
  await page.goto("/");
  await openModelMenu(page);
  await page.getByTestId(`model-option-${MODEL}`).click();
  await expect(page.getByTestId("composer-input")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("attach-input").setInputFiles([
    {
      name: "sales.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(makeXlsx({ Jan: [["product", "qty"], ["apples", 3], ["pears", 5]], Feb: [["product", "qty"], ["grapes", 7]] })),
    },
    {
      name: "notes.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from(await makeDocx({ heading: "Meeting notes", paragraphs: ["We sold apples and pears."], bullets: ["apples", "pears"] })),
    },
  ]);
  await expect(page.locator('[data-testid="draft-document"][data-state="ready"]')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('[data-testid="draft-document"][data-name="sales.xlsx"]')).toContainText("2 sheets");
  await page.getByTestId("composer-input").fill("How many apples were sold in January? Answer with one number.");
  await shot(page, info, "chat-docs-attached");
  await page.getByTestId("send").click();
  const docsMessage = page.getByTestId("message-user").last();
  await expect(docsMessage.getByTestId("document-chip")).toHaveCount(2);
  await expect(docsMessage.locator('[data-testid="document-chip"][data-kind="sheet"]')).toContainText("5 rows");
  await expect(docsMessage.locator('[data-testid="document-chip"][data-kind="docx"]')).toContainText("words");
  await expect(page.getByTestId("message-stats").last()).toBeVisible({ timeout: 60_000 });
  await shot(page, info, "chat-docs-reply");

  // ── documents: too long for the model → blocked before sending ─────────
  await page.goto("/");
  await expect(page.getByTestId("composer-input")).toBeEnabled({ timeout: 30_000 });
  const longText = "The quick brown fox jumps over the lazy dog. ".repeat(9000); // ~405k characters
  await page.getByTestId("attach-input").setInputFiles({ name: "long.txt", mimeType: "text/plain", buffer: Buffer.from(longText) });
  await expect(page.getByTestId("draft-document")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await page.getByTestId("composer-input").fill("Summarize.");
  await expect(page.getByTestId("composer-blocked")).toHaveText(/too long for this model|longo demais para este modelo/i);
  await expect(page.getByTestId("send")).toBeDisabled();
  await shot(page, info, "chat-doc-too-long");
  await page.getByTestId("draft-document-remove").click();
  await expect(page.getByTestId("composer-blocked")).toBeHidden();
  await page.getByTestId("composer-input").fill("");

  // ── agents and skills: kept by the computer; a chat with an agent ───────
  await page.goto("/skills");
  await expect(page.getByTestId("skill-list")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("skill-new").click();
  await page.getByTestId("skill-name").fill("Tone");
  await page.getByTestId("skill-category").click();
  await page.getByTestId("skill-category-writing").click();
  await page.getByTestId("skill-description").fill("When answering any question.");
  await page.getByTestId("skill-instructions").fill("# Tone\nAlways answer with one single word.");
  await page.getByTestId("skill-save").click();
  await expect(page.locator('[data-testid="skill-editor"][data-saved="true"]')).toBeVisible({ timeout: 30_000 });
  if (!desktop) await page.getByTestId("skill-back").click(); // the phone shows the list again
  await expect(page.locator('[data-testid="skill-row"][data-name="Tone"]')).toBeVisible();
  await shot(page, info, "skills");

  await page.goto("/agents");
  await expect(page.getByTestId("agents-empty")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("agent-new").click();
  await page.getByTestId("agent-icon-button").click();
  await page.getByTestId("icon-option-feather").click();
  await expect(page.getByTestId("agent-icon-button")).toHaveAttribute("data-icon", "feather");
  await page.getByTestId("agent-name").fill("Writer");
  await page.getByTestId("agent-description").fill("Answers with one word.");
  await page.getByTestId("agent-model").click();
  await page.getByTestId(`agent-model-${MODEL}`).click();
  await page.getByTestId("agent-option-temperature").fill("0");
  await page.getByTestId("agent-instructions").fill("You are an assistant that answers with a single word.");
  await page.getByTestId("agent-skills-selected").click();
  await page.getByTestId("agent-skills-add").click();
  await page.locator('[data-testid="skill-picker-option"][data-name="Tone"]').click();
  await page.getByTestId("skill-picker-done").click();
  await expect(page.locator('[data-testid="agent-skill-row"][data-name="Tone"]')).toBeVisible();
  await page.getByTestId("agent-save").click();
  await expect(page.locator('[data-testid="agent-editor"][data-saved="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("agent-select")).toContainText("Writer");
  await page.getByTestId("agent-select").scrollIntoViewIfNeeded();
  await shot(page, info, "agent-editor");
  // "Use": a new chat with the agent, its icon, name and description instead of the greeting; the
  // model is the agent's.
  await page.getByTestId("agent-use").click();
  await expect(page.getByTestId("agent-intro-name")).toHaveText("Writer", { timeout: 30_000 });
  await expect(page.getByTestId("agent-chip")).toContainText("Writer");
  await expect(page.getByTestId("model-picker")).toContainText(MODEL);
  await expect(page.getByTestId("model-picker")).toBeDisabled();
  await shot(page, info, "chat-agent");
  await page.getByTestId("composer-input").fill("Say hi");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("message-stats")).toBeVisible({ timeout: 60_000 });
  // The computer keeps the agent with the conversation: reopened, it is still applied.
  await page.goto(page.url());
  await expect(page.getByTestId("agent-chip")).toContainText("Writer", { timeout: 30_000 });
  // The sliders button next to "+": this computer's agents and skills.
  await page.getByTestId("tools-menu").click();
  await page.getByTestId("tools-agents").click();
  await expect(page.locator('[data-testid="agent-option"][data-name="Writer"]')).toBeVisible();
  await page.waitForTimeout(300); // let the menu finish opening before the screenshot
  await shot(page, info, "tools-menu");
  await page.getByTestId("agent-option-none").click();
  await expect(page.getByTestId("agent-chip")).toHaveCount(0);
  await expect(page.getByTestId("model-picker")).toBeEnabled();

  // ── agent chain (rev. 1.9): "Reviewer" answers after "Writer"; Writer's answer stays folded above
  // the reply, like the thinking, and the computer keeps it with the reply ─────────────────────
  await page.goto("/agents");
  await expect(page.getByTestId("agent-select")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("agent-new").click();
  await page.getByTestId("agent-name").fill("Reviewer");
  await page.getByTestId("agent-model").click();
  await page.getByTestId(`agent-model-${MODEL}`).click();
  await page.getByTestId("agent-instructions").fill("Answer with one word.");
  await page.getByTestId("agent-save").click();
  await expect(page.locator('[data-testid="agent-editor"][data-saved="true"]')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("agent-select").click();
  await page.locator('[data-testid="agent-select-option"][data-name="Writer"]').click();
  await expect(page.getByTestId("agent-name")).toHaveValue("Writer");
  await page.getByTestId("agent-advanced-toggle").click();
  await page.getByTestId("agent-chain-add").click();
  await page.getByTestId("agent-chain-option-Reviewer").click();
  await expect(page.locator('[data-testid="agent-chain-row"][data-name="Reviewer"]')).toBeVisible();
  await page.getByTestId("agent-chain").scrollIntoViewIfNeeded();
  await shot(page, info, "agent-chain");
  await page.getByTestId("agent-save").click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: /Agent saved|Agente salvo/ }).last()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("agent-use").click();
  await expect(page.getByTestId("agent-intro-name")).toHaveText("Writer", { timeout: 30_000 });
  await page.getByTestId("composer-input").fill("Say hi");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("chain-step")).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId("message-stats")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("chain-step")).toContainText("Writer");
  await page.getByTestId("chain-step").locator("button").click();
  await expect(page.getByTestId("chain-step-content")).toBeVisible();
  await shot(page, info, "chat-chain");
  await page.goto(page.url()); // reopened from the computer: the earlier answer is still there
  await expect(page.getByTestId("chain-step")).toHaveCount(1, { timeout: 30_000 });

  // ── a second browser signs in and is already paired (synced pairings) ───
  const context2 = await browser.newContext({ baseURL: info.project.use.baseURL ?? "http://localhost:5173", viewport: info.project.use.viewport ?? null });
  const page2 = await context2.newPage();
  await login(page2, email, PASSWORD);
  await page2.goto("/devices");
  const card2 = page2.getByTestId("device-card").first();
  await expect(card2).toHaveAttribute("data-paired", "true", { timeout: 30_000 });
  await expect(card2).toHaveAttribute("data-online", "true");
  await shot(page2, info, "synced-pairing");
  // The cookie survives but the local data is gone (iOS home-screen app, cleared site data): the
  // device shows as not paired and the password brings the synced pairings back.
  await page2.evaluate(async () => {
    const dbs = await indexedDB.databases();
    await Promise.all(
      dbs.map(
        (d) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(d.name ?? "");
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          }),
      ),
    );
  });
  await page2.reload();
  await expect(page2.getByTestId("pairings-unlock")).toBeVisible({ timeout: 30_000 });
  await expect(card2).toHaveAttribute("data-paired", "false");
  await shot(page2, info, "pairings-unlock");
  await page2.getByTestId("pairings-unlock-password").fill("not the password");
  await page2.getByTestId("pairings-unlock-submit").click();
  await expect(page2.getByTestId("pairings-unlock")).toBeVisible(); // still there: wrong password
  await page2.getByTestId("pairings-unlock-password").fill(PASSWORD);
  await page2.getByTestId("pairings-unlock-submit").click();
  await expect(card2).toHaveAttribute("data-paired", "true", { timeout: 30_000 });
  await expect(page2.getByTestId("pairings-unlock")).toBeHidden();
  await page2.goto("/");
  await expect(page2.getByTestId("chat-empty")).toBeVisible({ timeout: 30_000 });
  if (desktop) await expect(page2.getByTestId("device-picker")).toContainText("Desk PC", { timeout: 30_000 });
  else await expect(page2.getByTestId("model-picker")).toBeEnabled({ timeout: 30_000 });
  await openModelMenu(page2);
  if (!desktop) await expect(page2.getByTestId("device-picker")).toContainText("Desk PC", { timeout: 30_000 });
  await page2.getByTestId(`model-option-${MODEL}`).click({ timeout: 30_000 });
  await expect(page2.getByTestId("composer-input")).toBeEnabled({ timeout: 60_000 });
  await page2.getByTestId("composer-input").fill("Answer with one word: synced");
  await page2.getByTestId("send").click();
  await expect(page2.getByTestId("message-stats")).toBeVisible({ timeout: 60_000 });
  // The second browser got the name with the account (synced preferences) …
  await page2.goto("/");
  await expect(page2.getByTestId("chat-greeting")).toContainText("Ana", { timeout: 30_000 });
  // … and is listed among the active sessions: signing it out from the first browser ends it.
  await page.goto("/settings#account");
  if (!desktop) await page.getByTestId("settings-page-sessions").click();
  await expect(page.getByTestId("session-row").nth(1)).toBeVisible({ timeout: 30_000 }); // this one and the second browser
  await page.getByTestId("settings-sessions").scrollIntoViewIfNeeded();
  await shot(page, info, "settings-sessions");
  while ((await page.getByTestId("session-sign-out").count()) > 0) {
    const before = await page.getByTestId("session-row").count();
    await page.getByTestId("session-sign-out").first().click();
    await expect(page.getByTestId("session-row")).toHaveCount(before - 1);
  }
  await expect(page.locator('[data-testid="session-row"][data-current="true"]')).toHaveCount(1);
  await page2.reload();
  await expect(page2.getByTestId("login-form")).toBeVisible({ timeout: 30_000 });
  await closeSettings(page);
  await context2.close();

  // ── settings → security: two-step sign-in ───────────────────────────────
  await page.goto("/settings#security");
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await expect(page.getByTestId("settings-security")).toBeVisible();
  await shot(page, info, "settings-security");
  await page.getByTestId(desktop ? "settings-tab-general" : "settings-back").click();
  await page.getByTestId("theme-option-dark").click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.waitForTimeout(300);
  await shot(page, info, "settings-general-dark");
  await page.getByTestId("theme-option-light").click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.waitForTimeout(300);
  await shot(page, info, "settings-general");
  await page.getByTestId(desktop ? "settings-tab-account" : "settings-page-security").click();
  await expect(page.getByTestId("two-step")).toHaveAttribute("data-enabled", "false");
  await page.getByTestId("two-step-switch").click();
  await expect(page.getByTestId("two-step-setup")).toBeVisible({ timeout: 30_000 });
  const secret = (await page.getByTestId("two-step-secret").textContent())?.trim() ?? "";
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await expect(page.getByTestId("two-step-qr").locator("svg")).toBeVisible();
  await shot(page, info, "two-step-setup");
  await page.getByTestId("two-step-code").fill("000000");
  await page.getByTestId("two-step-enable").click();
  await expect(page.getByTestId("two-step-setup").getByRole("alert")).toBeVisible();
  await page.getByTestId("two-step-code").fill(await freshTotp(secret));
  await page.getByTestId("two-step-enable").click();
  await expect(page.getByTestId("two-step-setup")).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId("two-step")).toHaveAttribute("data-enabled", "true");
  await shot(page, info, "settings-two-step-on");

  // sign out → sign in needs the code
  await logout(page);
  await login(page, email, PASSWORD, () => freshTotp(secret), info);
  await page.goto("/settings#security");
  await expect(page.getByTestId("two-step")).toHaveAttribute("data-enabled", "true");
  await page.getByTestId("two-step-switch").click();
  await expect(page.getByTestId("two-step-disable")).toBeVisible();
  await page.getByTestId("two-step-disable-password").fill(PASSWORD);
  await page.getByTestId("two-step-disable-code").fill(await freshTotp(secret));
  await shot(page, info, "two-step-disable");
  await page.getByTestId("two-step-disable-confirm").click();
  await expect(page.getByTestId("two-step-disable")).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId("two-step")).toHaveAttribute("data-enabled", "false");

  // ── password change: the computer is disconnected; pair again with a new code ──
  await page.getByTestId("current-password").fill(PASSWORD);
  await page.getByTestId("new-password").fill(NEW_PASSWORD);
  await page.getByTestId("change-password").click();
  await expect(page.getByTestId("devices-disconnected")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="device-card"][data-paired="true"]')).toHaveCount(0);
  await shot(page, info, "devices-disconnected");
  await openSidebar(page);
  await expect(page.locator('[data-testid="conversation-item"]:visible')).toHaveCount(0);
  codeA = await pairFromDevices(page, trayA, codeA);
  await expect(page.getByTestId("devices-disconnected")).toBeHidden();
  await shot(page, info, "devices-repaired");
  await page.goto(convUrl); // the history on the computer is still there
  await expect(page.getByTestId("message-user")).toHaveCount(2, { timeout: 30_000 });

  // ── computer goes offline → explicit state, composer disabled ──────────
  trayA.stop();
  await page.goto("/devices");
  await expect(page.getByTestId("device-card").first()).toHaveAttribute("data-online", "false", { timeout: 30_000 });
  await shot(page, info, "devices-offline");
  await page.goto("/");
  await expect(page.getByTestId("composer-disabled-reason")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeDisabled();
  await openSidebar(page);
  await expect(page.locator('[data-testid="conversation-group-offline"]:visible')).toBeVisible();
  await shot(page, info, "chat-offline");

  // ── deep link /pair#CODE with a second tray ─────────────────────────────
  trayB = startTray("b");
  let codeB = await waitForPairingCode(trayB);
  await page.goto(`/pair#${codeB.replace(/-/g, "")}`);
  await expect(page.getByTestId("pair-success")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("pair-close").click();
  await expect(page.getByTestId("pair-dialog")).toBeHidden();
  await expect(page.getByTestId("device-card")).toHaveCount(2);
  await shot(page, info, "devices-two");

  // ── forgot password: e-mail code → new password → signed in, computers disconnected ──
  await logout(page);
  await page.getByTestId("link-forgot").click();
  await expect(page.getByTestId("forgot-email-form")).toBeVisible();
  await shot(page, info, "forgot-password");
  await page.getByTestId("email").fill(email);
  const since = Date.now();
  await submitWhenReady(page);
  await expect(page.getByTestId("forgot-code-form")).toBeVisible();
  await expect(page.getByTestId("resend-code")).toBeDisabled(); // 60 s cooldown
  await shot(page, info, "forgot-code");
  await page.getByTestId("reset-code").fill("000000");
  await page.getByTestId("password").fill(RESET_PASSWORD);
  await page.getByTestId("confirm").fill(RESET_PASSWORD);
  expect(await submitReset(page)).toBe("bad_code");
  await page.getByTestId("reset-code").fill(await waitForMailCode(email, since));
  // Signed in with the new password and sent to pair again: every device is gone. When the automatic
  // sign-in meets the per-IP login throttle, the app hands over to the login screen with the e-mail
  // filled in and a notice; the helper waits the throttle out.
  const landed = await submitReset(page);
  expect(landed).not.toBe("bad_code");
  if (landed === "login") {
    await shot(page, info, "login-after-reset");
    await login(page, email, RESET_PASSWORD);
    await page.goto("/devices");
  }
  await expect(page.getByTestId("devices-screen")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("add-device")).toBeVisible();
  await expect(page.locator('[data-testid="device-card"][data-paired="true"]')).toHaveCount(0);
  await shot(page, info, "devices-after-reset");
  codeB = await pairFromDevices(page, trayB, codeB);
  await shot(page, info, "devices-after-reset-paired");
  await expect(page.getByTestId("device-card").first()).toHaveAttribute("data-online", "true");

  // ── Settings → Conversations: what the computer keeps, Delete all ───────
  await page.goto("/");
  await openModelMenu(page);
  await page.getByTestId(`model-option-${MODEL}`).click();
  await expect(page.getByTestId("composer-input")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("composer-input").fill("Answer with one word: done");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("message-stats")).toBeVisible({ timeout: 60_000 });
  await openSidebar(page);
  await expect(page.locator('[data-testid="conversation-item"]:visible')).toHaveCount(1, { timeout: 30_000 });
  await page.goto("/settings");
  if (!desktop) await page.getByTestId("settings-page-conversations").click();
  const convRow = page.getByTestId("conversations-row").first();
  await expect(convRow).toHaveAttribute("data-count", "1", { timeout: 30_000 });
  await expect(convRow.getByTestId("conversations-summary")).toHaveText(/· 1 conversation · [\d.,]+ (KB|MB)$/);
  await convRow.scrollIntoViewIfNeeded();
  await shot(page, info, "settings-conversations");
  await convRow.getByTestId("conversations-delete-all").click();
  await expect(page.getByRole("alertdialog")).toContainText(/Delete all conversations on|Apagar todas as conversas em/);
  await shot(page, info, "settings-conversations-confirm");
  await page.getByTestId("conversations-delete-confirm").click();
  await expect(convRow).toHaveAttribute("data-count", "0", { timeout: 60_000 });
  await expect(convRow.getByTestId("conversations-delete-all")).toBeDisabled();
  await shot(page, info, "settings-conversations-cleared");
  await closeSettings(page);
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
  await openSidebar(page);
  await expect(page.locator('[data-testid="conversation-item"]:visible')).toHaveCount(0);

  // ── logout ──────────────────────────────────────────────────────────────
  await logout(page);
  await login(page, email, RESET_PASSWORD);
  await logout(page);
});
