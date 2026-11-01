// Phone drawer pieces (Sidebar mode "drawer"): a round search button next to the wordmark, and at
// the bottom the account's round initials (they open Settings, which hold the rest of the account
// menu on a phone) and a floating black "New chat".

import { useNavigate } from "react-router";
import { PlusIcon, SearchIcon } from "lucide-react";
import { cn } from "cn";
import { startNewChat } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { useDisplayName } from "@/lib/useDisplayName";
import { useAuth } from "@/stores/react";
import { uiStore } from "@/stores/ui";
import { roundButton } from "./phone";

/** "Thiago Bezerra" → "TB", "ana" → "A". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : (words[0]?.[0] ?? "?")).toUpperCase();
}

export function DrawerSearchButton({ open, onToggle }: { open: boolean; onToggle(): void }) {
  const { t } = useT();
  return (
    <Button variant="ghost" size="icon" className={cn("ml-auto", roundButton, open && "bg-muted")} onClick={onToggle} aria-label={t("sidebar.search")} aria-pressed={open} data-testid="drawer-search">
      <SearchIcon />
    </Button>
  );
}

export function DrawerFooter({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const { t } = useT();
  const navigate = useNavigate();
  const email = useAuth((s) => s.me?.email ?? "");
  const name = useDisplayName() || email;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-gradient-to-t from-sidebar via-sidebar/90 to-transparent px-4 pt-8 pb-safe">
      <button
        type="button"
        className="pointer-events-auto mb-4 flex size-12 shrink-0 items-center justify-center rounded-full bg-background text-[15px] font-medium shadow-[0_1px_8px_rgba(0,0,0,0.08)] dark:bg-card"
        onClick={() => {
          onNavigate?.();
          uiStore.getState().openSettings("general");
        }}
        aria-label={t("nav.settings")}
        data-testid="account-menu"
      >
        <span aria-hidden>{initials(name)}</span>
        <span className="sr-only">{name}</span>
      </button>
      <button
        type="button"
        className="pointer-events-auto mb-4 flex h-12 items-center gap-2 rounded-full bg-foreground px-6 text-[16px] font-medium text-background shadow-[0_4px_16px_rgba(0,0,0,0.18)]"
        onClick={() => {
          startNewChat(navigate);
          onNavigate?.();
        }}
        data-testid="new-chat"
      >
        <PlusIcon className="size-5" />
        {t("chat.new")}
      </button>
    </div>
  );
}
