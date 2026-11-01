// Settings on a phone: a full-screen page with the account card, rows grouped in cards (each opens
// its own page or acts in place), the theme as three preview cards and "Sign out" at the end; the
// "i" button holds the version and the public pages. The desktop keeps the window with tabs
// (SettingsDialog.tsx); both show the same sections.

import type { ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, ExternalLinkIcon, InfoIcon, XIcon } from "lucide-react";
import { cn } from "cn";
import { RELEASE_VERSION } from "@/app/bootstrap";
import { initials } from "@/components/layout/DrawerParts";
import { phoneCard, phoneCardLabel, phoneRow, phoneSurface, roundButton } from "@/components/layout/phone";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useT, type TKey } from "@/i18n";
import { useBuildRevision } from "@/lib/useBuildRevision";
import { useDisplayName } from "@/lib/useDisplayName";
import { downloadUrl, LICENSE_PATH, sitePageUrl, siteUrl, sourceUrl, THIRD_PARTY_LICENSES_PATH, type SitePage } from "@/lib/site";
import { authStore } from "@/stores/auth";
import { useAuth, useSettings, useUi } from "@/stores/react";
import { settingsStore } from "@/stores/settings";
import { uiStore, type SettingsPage } from "@/stores/ui";
import { ComputersSection, ProfileSection, SessionsSection } from "./AccountSections";
import { ConversationsSection } from "./ConversationsSection";
import { LANGUAGE_NAMES } from "./LanguageDialog";
import { WithoutSectionTitles } from "./layout";
import { SecuritySection } from "./SecuritySection";
import { ThemeCards } from "./ThemeCards";

const PAGES: Record<SettingsPage, { title: TKey; body: () => ReactNode }> = {
  profile: { title: "settings.profile", body: () => <ProfileSection /> },
  computers: { title: "settings.computers", body: () => <ComputersSection /> },
  sessions: { title: "settings.sessions", body: () => <SessionsSection /> },
  security: { title: "settings.security", body: () => <SecuritySection /> },
  conversations: { title: "settings.conversations", body: () => <ConversationsSection /> },
};

const ACCOUNT_PAGES: readonly SettingsPage[] = ["profile", "computers", "sessions", "security"];

const SITE_PAGES: readonly (readonly [SitePage, TKey])[] = [
  ["docs", "account.docs"],
  ["about", "account.about"],
  ["usage-policy", "account.usagePolicy"],
  ["privacy", "account.privacy"],
  ["terms", "account.terms"],
];

export function PhoneSettings() {
  const page = useUi((s) => s.settingsPage);
  return <div className={cn("flex min-h-0 flex-1 flex-col", phoneSurface)}>{page ? <Page page={page} /> : <Root />}</div>;
}

function Header({ left, title, right }: { left: ReactNode; title: string; right?: ReactNode }) {
  return (
    <div className="grid h-16 shrink-0 grid-cols-[3rem_1fr_3rem] items-center px-3">
      <div>{left}</div>
      <h2 className="truncate text-center text-[18px] font-semibold">{title}</h2>
      <div className="flex justify-end">{right}</div>
    </div>
  );
}

function Root() {
  const { t } = useT();
  const email = useAuth((s) => s.me?.email ?? "");
  const name = useDisplayName() || email;
  const settings = useSettings((s) => s.settings);
  const open = (page: SettingsPage) => () => uiStore.getState().setSettingsPage(page);
  return (
    <>
      <Header
        left={
          <DialogClose asChild>
            <Button variant="ghost" size="icon" className={roundButton} aria-label={t("common.close")} data-testid="settings-close">
              <XIcon />
            </Button>
          </DialogClose>
        }
        title={t("nav.settings")}
        right={<InfoMenu />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-safe" data-testid="settings-general">
        <div className={cn(phoneCard, "mt-2 flex items-center gap-4 p-4")} data-testid="settings-account-card">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-muted text-[18px] font-medium">{initials(name)}</span>
          <span className="min-w-0">
            <span className="block truncate text-[18px]">{name}</span>
            <span className="block truncate text-[15px] text-muted-foreground" data-testid="account-email">
              {email}
            </span>
          </span>
        </div>

        <p className={cn(phoneCardLabel, "mt-4")}>{t("settings.account")}</p>
        <div className={phoneCard}>
          {ACCOUNT_PAGES.map((page) => (
            <RowLink key={page} label={t(PAGES[page].title)} onClick={open(page)} testid={`settings-page-${page}`} />
          ))}
        </div>

        <p className={cn(phoneCardLabel, "mt-4")}>{t("settings.app")}</p>
        <div className={phoneCard}>
          <RowLink label={t("settings.conversations")} onClick={open("conversations")} testid="settings-page-conversations" />
          <RowLink
            label={t("settings.language")}
            value={settings.language ? LANGUAGE_NAMES[settings.language].native : t("language.autoName")}
            onClick={() => uiStore.getState().setLanguage(true)}
            testid="language-button"
          />
          <label className={cn(phoneRow, "cursor-pointer")}>
            <span className="min-w-0 flex-1">{t("settings.dictationShort")}</span>
            <Switch checked={settings.dictation} onCheckedChange={(v) => void settingsStore.getState().update({ dictation: v })} data-testid="dictation-switch" />
          </label>
        </div>

        <p className={cn(phoneCardLabel, "mt-4")}>{t("settings.appearance")}</p>
        <div className={phoneCard}>
          <ThemeCards />
        </div>

        <div className={cn(phoneCard, "mt-6 mb-6")}>
          <button
            type="button"
            className={cn(phoneRow, "text-destructive")}
            onClick={() => {
              uiStore.getState().closeSettings();
              void authStore.getState().logout();
            }}
            data-testid="settings-logout"
          >
            {t("auth.logout")}
          </button>
        </div>
      </div>
    </>
  );
}

function RowLink({ label, value, onClick, testid }: { label: string; value?: string; onClick(): void; testid: string }) {
  return (
    <button type="button" className={phoneRow} onClick={onClick} data-testid={testid}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value ? <span className="max-w-[45%] truncate text-[15px] text-muted-foreground">{value}</span> : null}
      <ChevronRightIcon className="size-5 opacity-60" />
    </button>
  );
}

/** One page of the list: back to the list on the left, the section itself without its title. */
function Page({ page }: { page: SettingsPage }) {
  const { t } = useT();
  return (
    <>
      <Header
        left={
          <Button variant="ghost" size="icon" className={roundButton} onClick={() => uiStore.getState().setSettingsPage(null)} aria-label={t("common.back")} data-testid="settings-back">
            <ChevronLeftIcon />
          </Button>
        }
        title={t(PAGES[page].title)}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-safe" data-testid={`settings-page-${page}-body`}>
        <div className={cn(phoneCard, "mt-2 mb-6 px-4")}>
          <WithoutSectionTitles>{PAGES[page].body()}</WithoutSectionTitles>
        </div>
      </div>
    </>
  );
}

/** The "i" at the top right: version and build, the licence and the source, the public pages and the computer app. */
function InfoMenu() {
  const { t, lang } = useT();
  const revision = useBuildRevision();
  const site = siteUrl();
  const app = downloadUrl(site);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={roundButton} aria-label={t("settings.about")} data-testid="settings-info">
          <InfoIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal" data-testid="settings-info-version">
          <span className="block text-[15px]" data-testid="app-version">
            Tunnelio {RELEASE_VERSION ?? t("settings.preRelease")}
          </span>
          <span className="block font-mono text-xs text-muted-foreground" data-testid="build-revision">
            {t("settings.build")}: {revision ? revision.slice(0, 7) : t("settings.buildUnknown")}
          </span>
          <span className="mt-1.5 block text-xs text-muted-foreground" data-testid="license-notice">
            {t("settings.licenseText")}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <a href={LICENSE_PATH} target="_blank" rel="noopener noreferrer" data-testid="license-text-link">
            {t("settings.licenseFull")}
            <ExternalLinkIcon className="ml-auto size-4! opacity-60" />
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={sourceUrl(revision)} target="_blank" rel="noopener noreferrer" data-testid="source-code-link">
            {t("settings.sourceCode")}
            <ExternalLinkIcon className="ml-auto size-4! opacity-60" />
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={THIRD_PARTY_LICENSES_PATH} target="_blank" rel="noopener noreferrer" data-testid="third-party-link">
            {t("settings.thirdParty")}
            <ExternalLinkIcon className="ml-auto size-4! opacity-60" />
          </a>
        </DropdownMenuItem>
        {site ? (
          <>
            <DropdownMenuSeparator />
            {SITE_PAGES.map(([page, key]) => {
              const href = sitePageUrl(page, lang, site);
              return href ? (
                <DropdownMenuItem key={page} asChild>
                  <a href={href} target="_blank" rel="noopener noreferrer" data-testid={`menu-${page}`}>
                    {t(key)}
                    <ExternalLinkIcon className="ml-auto size-4! opacity-60" />
                  </a>
                </DropdownMenuItem>
              ) : null;
            })}
            {app ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a href={app} target="_blank" rel="noopener noreferrer" data-testid="menu-get-app">
                    <DownloadIcon />
                    {t("account.getApp")}
                  </a>
                </DropdownMenuItem>
              </>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
