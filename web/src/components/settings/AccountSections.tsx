// Settings → Account: profile (the name Tunnelio calls you by, synced sealed in the account), the
// computers linked to the account, and the active sessions (signed-in browsers) with sign-out.

import { useEffect, useState } from "react";
import { MonitorIcon, MonitorSmartphoneIcon, SmartphoneIcon, TabletIcon } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { localeOf, useT, type TKey } from "@/i18n";
import type { LoginSessionRecord } from "@/lib/api";
import { formatDateTime, relativeTime } from "@/lib/format";
import { displayName } from "@/lib/greeting";
import { authStore } from "@/stores/auth";
import { useAuth, useDevices, useSettings } from "@/stores/react";
import { getRuntime } from "@/stores/runtime";
import { DISPLAY_NAME_MAX, settingsStore } from "@/stores/settings";
import { SettingsSection } from "./layout";

const PLATFORM: Record<string, string> = { linux: "Linux", macos: "macOS", windows: "Windows" };
const DEVICE: Record<LoginSessionRecord["device"], TKey> = {
  computer: "settings.deviceComputer",
  phone: "settings.devicePhone",
  tablet: "settings.deviceTablet",
  other: "settings.deviceOther",
};
const DEVICE_ICON = { computer: MonitorIcon, phone: SmartphoneIcon, tablet: TabletIcon, other: MonitorSmartphoneIcon } as const;

const dateOnly = (iso: string | null | undefined, locale: string) => (iso ? new Date(iso).toLocaleDateString(locale, { dateStyle: "medium" }) : "–");

export function ProfileSection() {
  const { t } = useT();
  const email = useAuth((s) => s.me?.email ?? "");
  const stored = useSettings((s) => s.settings.display_name);
  const [value, setValue] = useState(stored ?? "");
  // A change arriving from another browser (synced preferences) shows up here too.
  const [seen, setSeen] = useState(stored);
  if (seen !== stored) {
    setSeen(stored);
    setValue(stored ?? "");
  }
  const commit = () => {
    const next = value.replace(/\s+/g, " ").trim().slice(0, DISPLAY_NAME_MAX);
    if ((next || null) !== stored) void settingsStore.getState().update({ display_name: next || null });
  };
  return (
    <SettingsSection title={t("settings.profile")}>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4">
        <label htmlFor="display-name" className="min-w-0 flex-1 basis-56">
          <span className="block text-[14px]">{t("settings.callYou")}</span>
          <span className="mt-0.5 block text-[13px] text-muted-foreground">{t("settings.callYouHint")}</span>
        </label>
        <Input
          id="display-name"
          value={value}
          maxLength={DISPLAY_NAME_MAX}
          placeholder={displayName(email)}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="h-9 w-full rounded-lg sm:w-64"
          autoComplete="nickname"
          data-testid="display-name-input"
        />
      </div>
    </SettingsSection>
  );
}

export function ComputersSection() {
  const { t, lang } = useT();
  const locale = localeOf(lang);
  const devices = useDevices((s) => s.devices);
  const order = useDevices((s) => s.order);
  return (
    <SettingsSection title={t("settings.computers")} description={t("settings.computersHint")} testid="settings-computers">
      {order.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">{t("settings.computersNone")}</p>
      ) : (
        <Table
          head={[t("settings.colName"), t("settings.colSystem"), t("settings.colAdded"), t("settings.colLastSeen")]}
          hideOnPhone={[2]}
          rows={order.flatMap((id) => {
            const d = devices[id];
            if (!d) return [];
            return [
              {
                key: id,
                testid: "computer-row",
                cells: [
                  <span key="n" className="truncate">
                    {d.name || t("devices.unnamed")}
                  </span>,
                  PLATFORM[d.platform] || d.platform || "–", // blank until the account's list arrives
                  dateOnly(d.created_at, locale),
                  d.online ? t("settings.onlineNow") : d.last_seen_at ? relativeTime(d.last_seen_at, locale) : t("settings.never"),
                ],
              },
            ];
          })}
        />
      )}
    </SettingsSection>
  );
}

export function SessionsSection() {
  const { t, lang } = useT();
  const locale = localeOf(lang);
  const [rows, setRows] = useState<LoginSessionRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);
  useEffect(() => {
    let cancelled = false;
    getRuntime()
      .api.listSessions()
      .then((list) => {
        if (cancelled) return;
        setRows(list);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const signOut = async (row: LoginSessionRecord) => {
    try {
      await getRuntime().api.deleteSession(row.id);
    } catch {
      toast.error(t("settings.sessionsFailed"));
      return;
    }
    if (row.current) {
      await authStore.getState().logout();
      return;
    }
    toast.success(t("settings.sessionEnded"));
    reload();
  };
  const signOutAll = async () => {
    setConfirmAll(false);
    try {
      await getRuntime().api.logoutAll();
    } catch {
      toast.error(t("settings.sessionsFailed"));
      return;
    }
    await authStore.getState().logout(); // this session is gone too: clean up here
  };

  return (
    <SettingsSection title={t("settings.sessions")} description={t("settings.sessionsHint")} testid="settings-sessions">
      {failed ? <p className="py-4 text-sm text-destructive">{t("settings.sessionsFailed")}</p> : null}
      {rows ? (
        <Table
          head={[t("settings.colDevice"), t("settings.colCreated"), t("settings.colUpdated"), ""]}
          hideOnPhone={[1]}
          rows={rows.map((r) => {
            const Icon = DEVICE_ICON[r.device] ?? MonitorSmartphoneIcon;
            return {
              key: String(r.id),
              testid: "session-row",
              attrs: { "data-current": r.current ? "true" : "false" },
              cells: [
                <span key="d" className="flex min-w-0 items-center gap-2.5">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate">{[r.browser || t("settings.unknownBrowser"), r.os].filter(Boolean).join(" · ")}</span>
                    <span className="block text-[12px] text-muted-foreground">{t(DEVICE[r.device] ?? "settings.deviceOther")}</span>
                  </span>
                </span>,
                formatDateTime(r.created_at, locale),
                relativeTime(r.last_seen_at, locale),
                r.current ? (
                  <Badge key="c" variant="secondary" data-testid="session-current">
                    {t("settings.thisSession")}
                  </Badge>
                ) : (
                  <Button key="s" variant="ghost" className="h-8 rounded-lg px-2.5" onClick={() => void signOut(r)} data-testid="session-sign-out">
                    {t("settings.signOut")}
                  </Button>
                ),
              ],
            };
          })}
        />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4">
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-[14px]">{t("settings.signOutAll")}</p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{t("settings.signOutAllHint")}</p>
        </div>
        <Button variant="outline" className="h-9 rounded-lg" onClick={() => setConfirmAll(true)} data-testid="sessions-sign-out-all">
          {t("settings.signOutAll")}
        </Button>
      </div>
      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.signOutAllTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.signOutAllDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void signOutAll()} data-testid="sessions-sign-out-all-confirm">
              {t("settings.signOutAll")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

/** A plain table like the reference app's (header row, hairlines); `hideOnPhone` drops columns on narrow screens. */
function Table({ head, rows, hideOnPhone = [] }: { head: string[]; rows: { key: string; testid: string; attrs?: Record<string, string>; cells: React.ReactNode[] }[]; hideOnPhone?: number[] }) {
  const hide = (i: number) => (hideOnPhone.includes(i) ? "hidden sm:table-cell" : "");
  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed text-[14px]">
        <thead>
          <tr className="text-left text-[13px] text-muted-foreground">
            {head.map((h, i) => (
              <th key={i} className={`py-3 pr-4 font-normal ${hide(i)} ${i === head.length - 1 && h === "" ? "w-28" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t" data-testid={r.testid} {...r.attrs}>
              {r.cells.map((c, i) => (
                <td key={i} className={`py-3 pr-4 align-middle ${i === 0 ? "" : "text-muted-foreground"} ${hide(i)}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
