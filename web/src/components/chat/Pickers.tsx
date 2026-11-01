// Device picker (name + online dot + paired badge) as a quiet text button for the row under the
// composer box; the model menu lives in ModelMenu.tsx and shares the trigger style.

import { Link } from "react-router";
import { CheckIcon, ChevronDownIcon, MonitorSmartphoneIcon } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useT } from "@/i18n";
import { useDevices } from "@/stores/react";

export function OnlineDot({ online, className }: { online: boolean; className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", online ? "bg-emerald-500" : "bg-muted-foreground/40", className)} data-online={online} />;
}

// `shrink` overrides the button's own `shrink-0` so long names truncate instead of overflowing on a phone.
export const pickerTriggerClass = "h-8 max-w-[46vw] min-w-0 shrink gap-1.5 overflow-hidden rounded-lg px-2 text-[14px] font-normal text-muted-foreground hover:bg-accent/60 hover:text-foreground md:max-w-[20rem]";

export function DevicePicker({ value, onChange, disabled }: { value: string | null; onChange(id: string): void; disabled?: boolean }) {
  const { t } = useT();
  const devices = useDevices((s) => s.devices);
  const order = useDevices((s) => s.order);
  const current = value ? devices[value] : undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={pickerTriggerClass} disabled={disabled} data-testid="device-picker">
          {current ? <OnlineDot online={current.online} /> : <MonitorSmartphoneIcon className="size-4 opacity-70" />}
          <span className="truncate">{current?.name || t("chat.pickDevice")}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t("nav.devices")}</DropdownMenuLabel>
        {order.length === 0 ? <DropdownMenuItem disabled>{t("devices.none")}</DropdownMenuItem> : null}
        {order.map((id) => {
          const d = devices[id];
          if (!d) return null;
          return (
            <DropdownMenuItem key={id} onSelect={() => onChange(id)} data-testid={`device-option-${id}`}>
              <OnlineDot online={d.online} />
              <span className="min-w-0 flex-1 truncate">{d.name || t("devices.unnamed")}</span>
              {!d.paired ? <Badge variant="outline">{t("devices.notPaired")}</Badge> : null}
              {id === value ? <CheckIcon className="size-4" /> : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/devices">{t("devices.manage")}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
