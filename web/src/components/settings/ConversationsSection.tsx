// Settings → Conversations (rev. 1.4): one row per paired computer with what it keeps
// ("hal9000 · 45 conversations · 120 MB") and "Delete all" (`history_clear`, capability
// "history_clear"). Offline computer → a hint to turn it on; older Tunnelio → counts when it sends
// them, no button, a hint to update.

import { useEffect, useState } from "react";
import { Loader2Icon, MonitorSmartphoneIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { OnlineDot } from "@/components/chat/Pickers";
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
import { Button } from "@/components/ui/button";
import { localeOf, useT } from "@/i18n";
import { formatBytes } from "@/lib/format";
import type { DeviceEntry } from "@/stores/devices";
import { historyStore } from "@/stores/history";
import { useDevices, useHistory, useSessions } from "@/stores/react";
import { SettingsSection } from "./layout";

export const HISTORY_CLEAR_CAPABILITY = "history_clear";

export function ConversationsSection() {
  const { t } = useT();
  const devices = useDevices((s) => s.devices);
  const order = useDevices((s) => s.order);
  const paired = order.filter((id) => devices[id]?.paired);
  return (
    <SettingsSection title={t("settings.conversations")} description={t("settings.conversationsHint")} testid="settings-conversations">
      {paired.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">{t("settings.conversationsNone")}</p>
      ) : (
        paired.map((id) => <ComputerRow key={id} device={devices[id]!} />)
      )}
    </SettingsSection>
  );
}

function ComputerRow({ device }: { device: DeviceEntry }) {
  const { t, lang } = useT();
  const totals = useHistory((s) => s.totals[device.id]);
  const capabilities = useSessions((s) => s.sessions[device.id]?.device_info?.capabilities ?? null);
  const [confirm, setConfirm] = useState(false);
  const name = device.name || t("devices.unnamed");
  const locale = localeOf(lang);

  useEffect(() => {
    if (device.online) void historyStore.getState().loadTotals(device.id);
  }, [device.id, device.online]);

  const count = totals?.conversations ?? null;
  const parts = [name];
  if (device.online && count !== null) parts.push(count === 1 ? t("settings.conversationsCountOne") : t("settings.conversationsCount", { n: count.toLocaleString(locale) }));
  if (device.online && totals?.bytes != null) parts.push(formatBytes(totals.bytes, locale));
  const known = capabilities !== null;
  const canClear = capabilities?.includes(HISTORY_CLEAR_CAPABILITY) ?? false;

  const clear = async () => {
    setConfirm(false);
    if (await historyStore.getState().clearAll(device.id)) toast.success(t("settings.conversationsDeleted", { name }));
    else toast.error(t("settings.conversationsFailed", { name }));
  };

  return (
    <div
      className="flex flex-wrap items-center gap-3 py-4"
      data-testid="conversations-row"
      data-device-id={device.id}
      data-online={device.online}
      data-count={count ?? ""}
      data-can-clear={canClear ? "true" : "false"}
    >
      <MonitorSmartphoneIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[14px]">
          <OnlineDot online={device.online} />
          <span className="truncate" data-testid="conversations-summary">
            {parts.join(" · ")}
          </span>
          {device.online && totals?.loading && count === null ? <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" /> : null}
        </p>
        {!device.online ? (
          <p className="mt-0.5 text-xs text-muted-foreground" data-testid="conversations-offline">
            {t("settings.conversationsOffline", { name })}
          </p>
        ) : known && !canClear ? (
          <p className="mt-0.5 text-xs text-muted-foreground" data-testid="conversations-old">
            {t("settings.conversationsOld")}
          </p>
        ) : null}
      </div>
      {device.online && canClear ? (
        <Button variant="outline" className="h-9 rounded-lg text-destructive hover:text-destructive" disabled={totals?.clearing || count === 0} onClick={() => setConfirm(true)} data-testid="conversations-delete-all">
          {totals?.clearing ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
          {totals?.clearing ? t("settings.conversationsDeleting") : t("settings.conversationsDeleteAll")}
        </Button>
      ) : null}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.conversationsDeleteTitle", { name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.conversationsDeleteDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void clear()} className="bg-destructive text-white hover:bg-destructive/90" data-testid="conversations-delete-confirm">
              {t("settings.conversationsDeleteAll")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
