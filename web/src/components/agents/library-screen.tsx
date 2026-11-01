// Shared by the Agents and Skills screens: the computer they show (the default one, like the
// Models screen), its agents and skills loaded once it is reachable, what to say when it is not,
// and the "discard the changes?" window.

import { useEffect } from "react";
import { Loader2Icon } from "lucide-react";
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
import { useT } from "@/i18n";
import type { DeviceEntry } from "@/stores/devices";
import { EMPTY_LIBRARY, libraryStore, type DeviceLibrary } from "@/stores/library";
import { modelsStore } from "@/stores/models";
import { useDevices, useLibrary, useSettings } from "@/stores/react";

export interface LibraryDevice {
  deviceId: string | null;
  device: DeviceEntry | undefined;
  reachable: boolean;
  library: DeviceLibrary;
}

export function useLibraryDevice({ withModels = false }: { withModels?: boolean } = {}): LibraryDevice {
  const devices = useDevices((s) => s.devices);
  const order = useDevices((s) => s.order);
  const defaultDevice = useSettings((s) => s.settings.default_device_id);
  const deviceId = defaultDevice && devices[defaultDevice] ? defaultDevice : (order.find((id) => devices[id]?.paired && devices[id]?.online) ?? order[0] ?? null);
  const device = deviceId ? devices[deviceId] : undefined;
  const reachable = Boolean(device?.paired && device.online);
  const library = useLibrary((s) => (deviceId ? s.byDevice[deviceId] : undefined)) ?? EMPTY_LIBRARY;
  useEffect(() => {
    if (!deviceId || !reachable) return;
    void libraryStore.getState().load(deviceId, { force: true });
    if (withModels) void modelsStore.getState().list(deviceId).catch(() => undefined);
  }, [deviceId, reachable, withModels]);
  return { deviceId, device, reachable, library };
}

/** Why there is nothing to edit yet (no computer, offline, older app, loading, error), or null. */
export function LibraryStatus({ deviceId, device, reachable, library, testid }: LibraryDevice & { testid: string }) {
  const { t } = useT();
  let text: string | null = null;
  if (!deviceId) text = t("chat.noDevices");
  else if (!reachable) text = device?.paired ? t("chat.deviceOffline", { name: device.name }) : t("chat.deviceNotPaired");
  else if (library.supported === false) text = t("agents.updateApp", { device: device?.name ?? "" });
  else if (library.error && !library.loaded) text = t("agents.loadFailed", { error: library.error });
  else if (!library.loaded)
    return (
      <div className="flex justify-center py-10 text-muted-foreground" data-testid={`${testid}-loading`}>
        <Loader2Icon className="size-5 animate-spin" />
      </div>
    );
  if (!text) return null;
  return (
    <p className="text-sm text-muted-foreground" data-testid={`${testid}-unavailable`}>
      {text}
    </p>
  );
}

export function DiscardDialog({ open, onCancel, onDiscard }: { open: boolean; onCancel(): void; onDiscard(): void }) {
  const { t } = useT();
  return (
    <AlertDialog open={open} onOpenChange={(o) => (o ? undefined : onCancel())}>
      <AlertDialogContent data-testid="discard-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("agents.discardTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("agents.discardDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onDiscard} data-testid="discard-confirm">
            {t("agents.discard")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Confirm a destructive action (delete an agent or a skill). */
export function ConfirmDelete({ open, title, description, onCancel, onConfirm }: { open: boolean; title: string; description: string; onCancel(): void; onConfirm(): void }) {
  const { t } = useT();
  return (
    <AlertDialog open={open} onOpenChange={(o) => (o ? undefined : onCancel())}>
      <AlertDialogContent data-testid="confirm-delete">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm} data-testid="confirm-delete-action">
            {t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
