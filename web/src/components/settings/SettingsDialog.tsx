// Settings window: tabs on the left, rows on the right.
//   General: theme, language, dictation, conversations per computer, version.
//   Account: profile (what Tunnelio calls you), e-mail, computers, active sessions, two-step sign-in,
//   password change, account deletion.
// Opened from the account menu, ⇧⌘, and `/settings` (`#security` → Account). A phone shows the
// same sections as a list of pages instead (PhoneSettings.tsx).

import { ChevronDownIcon, CircleUserIcon, Settings2Icon, XIcon } from "lucide-react";
import { cn } from "cn";
import { RELEASE_VERSION } from "@/app/bootstrap";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useT, type TKey } from "@/i18n";
import { LICENSE_PATH, sourceUrl, THIRD_PARTY_LICENSES_PATH } from "@/lib/site";
import { useBuildRevision } from "@/lib/useBuildRevision";
import { useWide } from "@/lib/useWide";
import { useAuth, useSettings, useUi } from "@/stores/react";
import { settingsStore } from "@/stores/settings";
import { uiStore, type SettingsTab } from "@/stores/ui";
import { ComputersSection, ProfileSection, SessionsSection } from "./AccountSections";
import { ConversationsSection } from "./ConversationsSection";
import { LANGUAGE_NAMES } from "./LanguageDialog";
import { SettingsRow, SettingsSection } from "./layout";
import { PhoneSettings } from "./PhoneSettings";
import { SecuritySection } from "./SecuritySection";
import { ThemePicker } from "./ThemePicker";

const TABS: readonly (readonly [SettingsTab, typeof Settings2Icon, TKey])[] = [
  ["general", Settings2Icon, "settings.general"],
  ["account", CircleUserIcon, "settings.account"],
];

export function SettingsDialog() {
  const { t } = useT();
  const tab = useUi((s) => s.settings);
  const wide = useWide();
  return (
    <Dialog open={tab !== null} onOpenChange={(o) => (o ? undefined : uiStore.getState().closeSettings())}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(780px,calc(100dvh-2rem))] w-[min(1020px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none max-md:h-dvh max-md:w-screen max-md:rounded-none"
        data-testid="settings-dialog"
      >
        <DialogTitle className="sr-only">{t("nav.settings")}</DialogTitle>
        <DialogDescription className="sr-only">{t("nav.settings")}</DialogDescription>
        {wide ? (
          <>
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              <nav className="shrink-0 border-b p-3 pr-14 md:w-56 md:border-r md:border-b-0 md:pr-3" aria-label={t("nav.settings")}>
                <p className="px-2.5 pt-1 pb-2 text-xs text-muted-foreground">{t("nav.settings")}</p>
                <div className="flex gap-1 md:flex-col">
                  {TABS.map(([id, Icon, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => uiStore.getState().openSettings(id)}
                      className={cn(
                        "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors",
                        tab === id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                      )}
                      aria-current={tab === id ? "page" : undefined}
                      data-testid={`settings-tab-${id}`}
                    >
                      <Icon className="size-[18px]" />
                      {t(label)}
                    </button>
                  ))}
                </div>
              </nav>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 md:px-10 md:py-8" data-testid={`settings-${tab ?? "general"}`}>
                <div className="mx-auto max-w-2xl">{tab === "account" ? <AccountSettings /> : <GeneralSettings />}</div>
              </div>
            </div>
            <DialogClose asChild>
              <Button variant="ghost" size="icon" className="absolute top-3 right-3 [&_svg]:size-5" aria-label={t("common.close")} data-testid="settings-close">
                <XIcon />
              </Button>
            </DialogClose>
          </>
        ) : (
          <PhoneSettings />
        )}
      </DialogContent>
    </Dialog>
  );
}

function GeneralSettings() {
  const { t } = useT();
  const settings = useSettings((s) => s.settings);
  const languageName = settings.language ? LANGUAGE_NAMES[settings.language].native : t("language.autoName");
  return (
    <>
      <SettingsSection title={t("settings.appearance")}>
        <SettingsRow label={t("settings.theme")} hint={t("settings.themeHint")}>
          <ThemePicker />
        </SettingsRow>
        <SettingsRow label={t("settings.language")}>
          <Button variant="outline" className="h-9 gap-2 rounded-lg px-3 font-normal" onClick={() => uiStore.getState().setLanguage(true)} data-testid="language-button">
            {languageName}
            <ChevronDownIcon className="size-4 text-muted-foreground" />
          </Button>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("settings.chat")}>
        <SettingsRow label={t("settings.dictation")} hint={t("settings.dictationHint")}>
          <Switch checked={settings.dictation} onCheckedChange={(v) => void settingsStore.getState().update({ dictation: v })} data-testid="dictation-switch" />
        </SettingsRow>
      </SettingsSection>

      <ConversationsSection />

      <SettingsSection title={t("settings.about")}>
        <SettingsRow label={t("settings.version")} hint={t("settings.aboutText")}>
          <span className="text-sm text-muted-foreground" data-testid="app-version">
            Tunnelio {RELEASE_VERSION ?? t("settings.preRelease")}
          </span>
        </SettingsRow>
        <BuildRow />
        <LicenseRow />
      </SettingsSection>
    </>
  );
}

function AccountSettings() {
  const { t } = useT();
  const email = useAuth((s) => s.me?.email ?? "");
  return (
    <>
      <ProfileSection />
      <SettingsSection title={t("settings.account")}>
        <SettingsRow label={t("settings.email")}>
          <span className="text-sm text-muted-foreground" data-testid="account-email">
            {email}
          </span>
        </SettingsRow>
      </SettingsSection>
      <ComputersSection />
      <SessionsSection />
      <SecuritySection />
    </>
  );
}

/** The legal notices the AGPL-3.0 asks for: copyright, licence and its text, no warranty, and where the source is. */
function LicenseRow() {
  const { t } = useT();
  const revision = useBuildRevision();
  const link = "text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground";
  return (
    <SettingsRow label={t("settings.license")} hint={t("settings.licenseText")} testid="license-row">
      <span className="flex flex-wrap justify-end gap-x-4 gap-y-1">
        <a href={LICENSE_PATH} target="_blank" rel="noopener noreferrer" className={link} data-testid="license-text-link">
          {t("settings.licenseFull")}
        </a>
        <a href={sourceUrl(revision)} target="_blank" rel="noopener noreferrer" className={link} data-testid="source-code-link">
          {t("settings.sourceCode")}
        </a>
        <a href={THIRD_PARTY_LICENSES_PATH} target="_blank" rel="noopener noreferrer" className={link} data-testid="third-party-link">
          {t("settings.thirdParty")}
        </a>
      </span>
    </SettingsRow>
  );
}

/** The public commit of this build, so anyone can rebuild it and compare (README → Verifying). */
function BuildRow() {
  const { t } = useT();
  const revision = useBuildRevision();
  return (
    <SettingsRow label={t("settings.build")} hint={t("settings.buildHint")}>
      <span className="font-mono text-sm text-muted-foreground" data-testid="build-revision" title={revision ?? undefined}>
        {revision ? revision.slice(0, 7) : t("settings.buildUnknown")}
      </span>
    </SettingsRow>
  );
}
