// Shell helpers: links to the public site (derived from app.<site>), keyboard shortcuts, and the
// sidebar settings kept in the browser (pinned conversations, sidebar pinned).

import { beforeEach, describe, expect, it } from "vitest";
import { matchShortcut, shortcutKeys } from "../src/lib/shortcuts";
import { downloadUrl, LICENSE_PATH, sitePageUrl, siteUrl, sourceUrl, THIRD_PARTY_LICENSES_PATH } from "../src/lib/site";
import { createMemoryStorage } from "../src/lib/storage";
import { configureRuntime, type Runtime } from "../src/stores/runtime";
import { settingsStore } from "../src/stores/settings";

describe("site links", () => {
  it("derives the site from app.<site> and hides it elsewhere", () => {
    expect(siteUrl({ protocol: "https:", hostname: "app.example.com", port: "" })).toBe("https://example.com");
    expect(siteUrl({ protocol: "http:", hostname: "app.localhost", port: "8080" })).toBe("http://localhost:8080");
    expect(siteUrl({ protocol: "http:", hostname: "localhost", port: "5173" })).toBeNull();
    expect(siteUrl({ protocol: "https:", hostname: "chat.example.com", port: "" })).toBeNull();
    expect(siteUrl({ protocol: "https:", hostname: "app.", port: "" })).toBeNull();
  });

  it("points to the page in the reader's language", () => {
    expect(sitePageUrl("terms", "en", "https://example.com")).toBe("https://example.com/terms.html");
    expect(sitePageUrl("privacy", "pt-BR", "https://example.com")).toBe("https://example.com/pt/privacy.html");
    expect(sitePageUrl("about", "en", null)).toBeNull();
    expect(downloadUrl("https://example.com")).toBe("https://example.com/#download");
    expect(downloadUrl(null)).toBeNull();
  });

  it("offers the licence, the source of this very build and the third-party licences (AGPL-3.0)", () => {
    expect(LICENSE_PATH).toBe("/LICENSE.txt");
    expect(sourceUrl("0123abc")).toBe("https://github.com/ThiagoBzMd/tunnelio/tree/0123abc");
    expect(sourceUrl(null)).toBe("https://github.com/ThiagoBzMd/tunnelio");
    expect(THIRD_PARTY_LICENSES_PATH).toBe("/third-party-licenses.txt");
  });
});

describe("keyboard shortcuts", () => {
  const key = (code: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
    code,
    metaKey: Boolean(mods.meta),
    ctrlKey: Boolean(mods.ctrl),
    shiftKey: Boolean(mods.shift),
    altKey: Boolean(mods.alt),
  });

  it("matches ⌘ on Apple platforms and Ctrl elsewhere, by key position", () => {
    expect(matchShortcut(key("KeyO", { meta: true, shift: true }), true)).toBe("newChat");
    expect(matchShortcut(key("KeyO", { ctrl: true, shift: true }), false)).toBe("newChat");
    expect(matchShortcut(key("KeyO", { ctrl: true, shift: true }), true)).toBeNull();
    expect(matchShortcut(key("Period", { ctrl: true }), false)).toBe("toggleSidebar");
    expect(matchShortcut(key("Comma", { meta: true, shift: true }), true)).toBe("settings");
    expect(matchShortcut(key("Slash", { meta: true }), true)).toBe("shortcuts");
    expect(matchShortcut(key("Slash", { meta: true, alt: true }), true)).toBeNull();
    expect(matchShortcut(key("KeyO", { meta: true }), true)).toBeNull();
    expect(matchShortcut(key("KeyX", { meta: true }), true)).toBeNull();
  });

  it("labels the keys per platform", () => {
    expect(shortcutKeys("newChat", true)).toEqual(["⇧", "⌘", "O"]);
    expect(shortcutKeys("newChat", false)).toEqual(["Ctrl", "Shift", "O"]);
    expect(shortcutKeys("shortcuts", false)).toEqual(["Ctrl", "/"]);
  });
});

describe("sidebar settings", () => {
  beforeEach(() => {
    configureRuntime({ storage: createMemoryStorage() } as unknown as Runtime);
    settingsStore.getState().reset();
  });

  it("pins most recent first, unpins, and survives a reload", async () => {
    expect(settingsStore.getState().settings).toMatchObject({ sidebar_pinned: true, pinned_conversations: [] });
    await settingsStore.getState().setPinned("a", true);
    await settingsStore.getState().setPinned("b", true);
    await settingsStore.getState().setPinned("a", true);
    expect(settingsStore.getState().settings.pinned_conversations).toEqual(["a", "b"]);
    await settingsStore.getState().setPinned("b", false);
    await settingsStore.getState().update({ sidebar_pinned: false });
    settingsStore.getState().reset();
    expect(await settingsStore.getState().load()).toMatchObject({ pinned_conversations: ["a"], sidebar_pinned: false });
  });

  it("drops junk from stored values", async () => {
    await settingsStore.getState().update({ pinned_conversations: ["ok", "", 3, "ok", "x".repeat(65)] as unknown as string[], sidebar_pinned: "yes" as unknown as boolean });
    expect(settingsStore.getState().settings.pinned_conversations).toEqual(["ok"]);
    expect(settingsStore.getState().settings.sidebar_pinned).toBe(true);
  });
});
