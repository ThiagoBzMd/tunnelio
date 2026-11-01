// The app's keyboard shortcuts (the "Keyboard shortcuts" window lists exactly these). ⌘ on
// Apple platforms, Ctrl elsewhere; matched on `code` so the keyboard layout does not matter.

export type ShortcutId = "newChat" | "toggleSidebar" | "settings" | "shortcuts";

export interface Shortcut {
  id: ShortcutId;
  code: string;
  shift: boolean;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "newChat", code: "KeyO", shift: true },
  { id: "toggleSidebar", code: "Period", shift: false },
  { id: "settings", code: "Comma", shift: true },
  { id: "shortcuts", code: "Slash", shift: false },
];

export function isApplePlatform(nav: Pick<Navigator, "platform" | "userAgent"> = navigator): boolean {
  return /Mac|iPhone|iPad|iPod/.test(nav.platform || nav.userAgent);
}

type KeyLike = Pick<KeyboardEvent, "code" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">;

/** The shortcut this key press triggers, if any (the platform's modifier, nothing else held). */
export function matchShortcut(e: KeyLike, apple: boolean): ShortcutId | null {
  const mod = apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey) return null;
  return SHORTCUTS.find((s) => s.code === e.code && s.shift === e.shiftKey)?.id ?? null;
}

const KEY_LABEL: Record<string, string> = { KeyO: "O", Period: ".", Comma: ",", Slash: "/" };

/** The keys to show, e.g. ["⇧", "⌘", "O"] on a Mac, ["Ctrl", "Shift", "O"] elsewhere. */
export function shortcutKeys(id: ShortcutId, apple: boolean): string[] {
  const s = SHORTCUTS.find((x) => x.id === id);
  if (!s) return [];
  const key = KEY_LABEL[s.code] ?? s.code;
  if (apple) return [...(s.shift ? ["⇧"] : []), "⌘", key];
  return ["Ctrl", ...(s.shift ? ["Shift"] : []), key];
}
