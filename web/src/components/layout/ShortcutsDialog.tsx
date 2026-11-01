// "Keyboard shortcuts": the app's shortcuts (lib/shortcuts.ts) plus the composer's keys.

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT, type TKey } from "@/i18n";
import { isApplePlatform, shortcutKeys, type ShortcutId } from "@/lib/shortcuts";
import { useUi } from "@/stores/react";
import { uiStore } from "@/stores/ui";

const APP: readonly (readonly [ShortcutId, TKey])[] = [
  ["newChat", "shortcuts.newChat"],
  ["toggleSidebar", "shortcuts.toggleSidebar"],
  ["settings", "shortcuts.settings"],
  ["shortcuts", "shortcuts.shortcuts"],
];

export function ShortcutsDialog() {
  const { t } = useT();
  const open = useUi((s) => s.shortcuts);
  const apple = isApplePlatform();
  const rows: [string, string[]][] = [
    ...APP.map(([id, key]): [string, string[]] => [t(key), shortcutKeys(id, apple)]),
    [t("shortcuts.send"), ["Enter"]],
    [t("shortcuts.newline"), [apple ? "⇧" : "Shift", "Enter"]],
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => uiStore.getState().setShortcuts(o)}>
      <DialogContent className="sm:max-w-md" data-testid="shortcuts-dialog">
        <DialogHeader>
          <DialogTitle className="text-lg">{t("shortcuts.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("shortcuts.title")}</DialogDescription>
        </DialogHeader>
        <ul className="divide-y">
          {rows.map(([label, keys]) => (
            <li key={label} className="flex items-center justify-between gap-4 py-2.5 text-sm">
              <span>{label}</span>
              <span className="flex gap-1">
                {keys.map((k) => (
                  <kbd key={k} className="min-w-6 rounded-md border bg-muted px-1.5 py-0.5 text-center font-sans text-xs text-muted-foreground">
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
