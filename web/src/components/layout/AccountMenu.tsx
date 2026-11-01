// The account button at the bottom of the sidebar and its menu: e-mail, Settings, Language, the
// computer app download, "Learn more" (the docs, about, policies, keyboard shortcuts) and Log out. Links to
// the public site only exist when the app is served from app.<site> (lib/site.ts).

import { ChevronsUpDownIcon, DownloadIcon, ExternalLinkIcon, GlobeIcon, InfoIcon, KeyboardIcon, LogOutIcon, SettingsIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT, type TKey } from "@/i18n";
import { useDisplayName } from "@/lib/useDisplayName";
import { isApplePlatform, shortcutKeys } from "@/lib/shortcuts";
import { downloadUrl, sitePageUrl, siteUrl, type SitePage } from "@/lib/site";
import { authStore } from "@/stores/auth";
import { useAuth } from "@/stores/react";
import { uiStore } from "@/stores/ui";

const PAGES: readonly (readonly [SitePage, TKey])[] = [
  ["usage-policy", "account.usagePolicy"],
  ["privacy", "account.privacy"],
  ["terms", "account.terms"],
];

export function AccountMenu({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const { t, lang } = useT();
  const email = useAuth((s) => s.me?.email ?? "");
  const name = useDisplayName() || email;
  const site = siteUrl();
  const apple = isApplePlatform();
  const open = (fn: () => void) => () => {
    onNavigate?.();
    fn();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex h-12 w-full items-center gap-2.5 rounded-lg px-2 text-left hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent" data-testid="account-menu">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/85 text-[13px] font-medium text-background uppercase">{(name || "?").slice(0, 1)}</span>
          <span className="min-w-0 flex-1 truncate text-[14px]">{name}</span>
          <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-64">
        <DropdownMenuLabel className="truncate" data-testid="account-email-label">
          {email}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={open(() => uiStore.getState().openSettings("general"))} data-testid="menu-settings">
          <SettingsIcon />
          {t("nav.settings")}
          <DropdownMenuShortcut>{shortcutKeys("settings", apple).join(apple ? "" : "+")}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={open(() => uiStore.getState().setLanguage(true))} data-testid="menu-language">
          <GlobeIcon />
          {t("settings.language")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {site ? (
          <DropdownMenuItem asChild>
            <a href={downloadUrl(site) ?? "#"} target="_blank" rel="noopener noreferrer" data-testid="menu-get-app">
              <DownloadIcon />
              {t("account.getApp")}
              <ExternalLinkIcon className="ml-auto size-4! opacity-60" />
            </a>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="menu-learn-more">
            <InfoIcon />
            {t("account.learnMore")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-60">
            {site ? (
              <>
                <ExternalItem href={sitePageUrl("docs", lang, site)} label={t("account.docs")} testid="menu-docs" />
                <ExternalItem href={sitePageUrl("about", lang, site)} label={t("account.about")} testid="menu-about" />
                <DropdownMenuSeparator />
                {PAGES.map(([page, key]) => (
                  <ExternalItem key={page} href={sitePageUrl(page, lang, site)} label={t(key)} testid={`menu-${page}`} />
                ))}
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem onSelect={open(() => uiStore.getState().setShortcuts(true))} data-testid="menu-shortcuts">
              <KeyboardIcon />
              {t("account.shortcuts")}
              <DropdownMenuShortcut>{shortcutKeys("shortcuts", apple).join(apple ? "" : "+")}</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void authStore.getState().logout()} data-testid="menu-logout">
          <LogOutIcon />
          {t("auth.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ExternalItem({ href, label, testid }: { href: string | null; label: string; testid: string }) {
  if (!href) return null;
  return (
    <DropdownMenuItem asChild>
      <a href={href} target="_blank" rel="noopener noreferrer" data-testid={testid}>
        {label}
        <ExternalLinkIcon className="ml-auto size-4! opacity-60" />
      </a>
    </DropdownMenuItem>
  );
}

