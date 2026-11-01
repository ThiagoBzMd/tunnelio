// Devices: list (online, paired on this browser, rename, remove) + "add a device" + pairing dialog.
// Also the target of the QR deep link `/pair#CODE` (SPEC §2.2): the fragment stays client-side.

import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { KeyRoundIcon, Link2Icon, MonitorSmartphoneIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon, UnlinkIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { OnlineDot } from "@/components/chat/Pickers";
import { PairDialog } from "@/components/devices/PairDialog";
import { ScreenBody, ScreenHeader } from "@/components/layout/ScreenHeader";
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
import { localeOf, useT } from "@/i18n";
import { relativeTime } from "@/lib/format";
import { authStore } from "@/stores/auth";
import type { DeviceEntry } from "@/stores/devices";
import { devicesStore } from "@/stores/devices";
import { unlockPairings } from "@/stores/pairing-sync";
import { useAuth, useDevices } from "@/stores/react";

const CODE_FRAGMENT = /^#?([0-9A-Za-z-]{12,14})$/;

export function DevicesScreen() {
  const { t } = useT();
  const loc = useLocation();
  const navigate = useNavigate();
  const devices = useDevices((s) => s.devices);
  const order = useDevices((s) => s.order);
  const busy = useDevices((s) => s.busy);
  const loaded = useDevices((s) => s.loaded);
  const disconnected = useAuth((s) => s.disconnected);
  const pairingsKeyPresent = useAuth((s) => s.pairingsKeyPresent);
  const needsUnlock = loaded && !pairingsKeyPresent && order.some((id) => devices[id] && !devices[id]?.paired);
  const [dialog, setDialog] = useState<{ open: boolean; key: number; code?: string; auto?: boolean; deviceName?: string }>({ open: false, key: 0 });
  const [consumed, setConsumed] = useState<string | null>(null);
  const openDialog = (extra: { code?: string; auto?: boolean; deviceName?: string } = {}) => setDialog((d) => ({ open: true, key: d.key + 1, ...extra }));

  // Deep link: /pair#CODE → open the dialog pre-filled and start immediately (consumed during render).
  const deepCode = loc.pathname === "/pair" ? CODE_FRAGMENT.exec(loc.hash)?.[1] : undefined;
  if (deepCode && consumed !== deepCode) {
    setConsumed(deepCode);
    openDialog({ code: deepCode, auto: true });
  }
  useEffect(() => {
    if (deepCode) navigate("/devices", { replace: true });
  }, [deepCode, navigate]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="devices-screen">
      <ScreenHeader
        title={t("nav.devices")}
        actions={
          <Button variant="ghost" size="icon-sm" onClick={() => void devicesStore.getState().refresh()} disabled={busy} aria-label={t("common.refresh")} data-testid="devices-refresh">
            <RefreshCwIcon className={busy ? "animate-spin" : ""} />
          </Button>
        }
      />
      <ScreenBody>
        {disconnected ? (
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4" data-testid="devices-disconnected">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t("devices.disconnectedTitle")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t("devices.disconnectedHint")}</p>
            </div>
            <Button variant="ghost" size="icon-xs" aria-label={t("common.done")} onClick={() => authStore.getState().clearDisconnected()} data-testid="devices-disconnected-dismiss">
              <XIcon />
            </Button>
          </div>
        ) : null}
        {needsUnlock ? <UnlockCard /> : null}
        {loaded && order.length === 0 ? null : (
          <div className="grid gap-3" data-testid="device-list">
            {order.map((id) => {
              const d = devices[id];
              return d ? <DeviceCard key={id} device={d} onPair={() => openDialog({ deviceName: d.name })} /> : null;
            })}
          </div>
        )}
        <AddDeviceCard first={loaded && order.length === 0} onPair={() => openDialog()} />
      </ScreenBody>
      <PairDialog
        key={dialog.key}
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        {...(dialog.code ? { initialCode: dialog.code } : {})}
        {...(dialog.auto ? { autoStart: true } : {})}
        {...(dialog.deviceName ? { deviceName: dialog.deviceName } : {})}
      />
    </div>
  );
}

function DeviceCard({ device, onPair }: { device: DeviceEntry; onPair(): void }) {
  const { t, lang } = useT();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    if (value && value !== device.name) {
      if (!(await devicesStore.getState().rename(device.id, value))) toast.error(t("devices.renameFailed"));
    }
    setEditing(false);
  };

  return (
    <div className="rounded-xl border bg-card p-4" data-testid="device-card" data-device-id={device.id} data-online={device.online} data-paired={device.paired}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <MonitorSmartphoneIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          {editing ? (
            <form onSubmit={(e) => void rename(e)} className="flex items-center gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus className="h-8" data-testid="device-name-input" />
              <Button type="submit" size="sm">
                {t("common.save")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {t("common.cancel")}
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate font-medium" data-testid="device-name">
                {device.name || t("devices.unnamed")}
              </h2>
              <Button variant="ghost" size="icon-xs" onClick={() => setEditing(true)} aria-label={t("devices.rename")} data-testid="device-rename">
                <PencilIcon />
              </Button>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="device-status">
                <OnlineDot online={device.online} />
                {device.online ? t("devices.online") : t("devices.offline")}
              </span>
              {device.paired ? <Badge variant="secondary">{t("devices.pairedHere")}</Badge> : <Badge variant="outline">{t("devices.notPaired")}</Badge>}
            </div>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {[device.platform, device.tray_version ? `tray ${device.tray_version}` : null, device.last_seen_at ? t("devices.lastSeen", { when: relativeTime(device.last_seen_at, localeOf(lang)) }) : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {device.paired ? (
          <Button variant="outline" size="sm" onClick={() => void devicesStore.getState().forget(device.id)} data-testid="device-forget">
            <UnlinkIcon />
            {t("devices.forget")}
          </Button>
        ) : (
          <Button size="sm" onClick={onPair} data-testid="device-pair">
            <Link2Icon />
            {t("devices.pairThisBrowser")}
          </Button>
        )}
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmRemove(true)} data-testid="device-remove">
          <Trash2Icon />
          {t("devices.remove")}
        </Button>
      </div>
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("devices.removeTitle", { name: device.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("devices.removeDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void devicesStore
                  .getState()
                  .remove(device.id)
                  .then((ok) => (ok ? toast.success(t("devices.removed")) : toast.error(t("devices.removeFailed"))));
              }}
              data-testid="device-remove-confirm"
            >
              {t("devices.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AddDeviceCard({ first, onPair }: { first: boolean; onPair(): void }) {
  const { t } = useT();
  return (
    <div className={first ? "rounded-xl border border-dashed p-6 text-center" : "rounded-xl border border-dashed p-4"} data-testid="add-device">
      {first ? <MonitorSmartphoneIcon className="mx-auto mb-2 size-8 text-muted-foreground" /> : null}
      <h2 className="font-medium">{first ? t("devices.addFirstTitle") : t("devices.addTitle")}</h2>
      <ol className={first ? "mx-auto mt-2 max-w-sm list-decimal space-y-1 text-left text-sm text-muted-foreground" : "mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground"}>
        <li>{t("devices.addStep1")}</li>
        <li>{t("devices.addStep2")}</li>
        <li>{t("devices.addStep3")}</li>
      </ol>
      <Button className="mt-4" onClick={onPair} data-testid="add-device-button">
        <PlusIcon />
        {t("devices.enterCode")}
      </Button>
    </div>
  );
}

/** Signed in without the pairings key: the password brings the synced pairings to this browser. */
function UnlockCard() {
  const { t } = useT();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    try {
      const result = await unlockPairings(password);
      if (result === "ok") {
        toast.success(t("devices.unlockDone"));
        setPassword("");
        await devicesStore.getState().refresh();
      } else toast.error(result === "wrong_password" ? t("devices.unlockWrong") : t("devices.unlockNothing"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4" data-testid="pairings-unlock">
      <KeyRoundIcon className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("devices.unlockTitle")}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t("devices.unlockHint")}</p>
        <div className="mt-3 flex gap-2">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("devices.unlockPassword")} autoComplete="current-password" className="max-w-xs" data-testid="pairings-unlock-password" />
          <Button type="submit" disabled={!password || busy} data-testid="pairings-unlock-submit">
            {t("devices.unlockSubmit")}
          </Button>
        </div>
      </div>
    </form>
  );
}
