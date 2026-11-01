// The model menu under the composer box, in sections: the computer's installed models (maker logo,
// "loaded"), the per-model settings dialog, the most popular models of the Ollama library not
// installed yet (→ Models screen to pick a size), and the full catalog. The thinking toggle sits
// next to the trigger (ThinkToggle.tsx).

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { CheckIcon, ChevronDownIcon, Loader2Icon, SlidersHorizontalIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/i18n";
import { familyOf } from "@/lib/makers";
import { hasCustomOptions } from "@/lib/model-options";
import { catalogStore } from "@/stores/catalog";
import { useCatalog, useDevices, useModels, useSettings } from "@/stores/react";
import { QuickDownload } from "@/components/models/Downloads";
import { MakerIcon } from "./MakerIcon";
import { ModelOptionsDialog } from "./ModelOptionsDialog";
import { pickerTriggerClass } from "./Pickers";

const OTHERS_SHOWN = 6;

export function ModelMenu({ deviceId, value, onChange, disabled }: { deviceId: string | null; value: string | null; onChange(name: string): void; disabled?: boolean }) {
  const { t } = useT();
  const navigate = useNavigate();
  const entry = useModels((s) => (deviceId ? s.byDevice[deviceId] : undefined));
  const deviceName = useDevices((s) => (deviceId ? s.devices[deviceId]?.name : undefined));
  const custom = useSettings((s) => (value ? hasCustomOptions(s.settings.model_options[value]) : false));
  const catalog = useCatalog((s) => s.catalog);
  const [optionsOpen, setOptionsOpen] = useState(false);
  useEffect(() => {
    void catalogStore.getState().load();
  }, []);

  const models = entry?.models ?? [];
  const running = new Set((entry?.running ?? []).map((m) => m.name));
  const installed = new Set(models.map((m) => familyOf(m.name)));
  // Chat models only (no embedders), most popular first as the library sorts them.
  const others = (catalog?.models ?? []).filter((m) => !installed.has(m.name) && !m.capabilities.includes("embedding")).slice(0, OTHERS_SHOWN);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className={pickerTriggerClass} disabled={disabled || !deviceId} data-testid="model-picker" data-custom={custom ? "true" : "false"}>
            {entry?.loading && models.length === 0 ? <Loader2Icon className="size-3.5 animate-spin" /> : value ? <MakerIcon model={value} className="size-4" /> : null}
            <span className="truncate text-foreground/90">{value ?? t("chat.pickModel")}</span>
            {custom ? <span className="shrink-0 text-[11px] opacity-70">· {t("models.optionsCustom")}</span> : null}
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="max-h-[70vh] w-96 overflow-y-auto">
          <DropdownMenuLabel className="text-xs text-muted-foreground">{deviceName ? t("models.menuInstalled", { device: deviceName }) : t("nav.models")}</DropdownMenuLabel>
          {models.length === 0 ? <DropdownMenuItem disabled>{entry?.loading ? t("common.loading") : t("models.none")}</DropdownMenuItem> : null}
          {models.map((m) => (
            <DropdownMenuItem key={m.name} onSelect={() => onChange(m.name)} data-testid={`model-option-${m.name}`}>
              <MakerIcon model={m.name} className="size-4" />
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              {running.has(m.name) ? <Badge variant="secondary">{t("models.loaded")}</Badge> : null}
              {m.name === value ? <CheckIcon className="size-4" /> : null}
            </DropdownMenuItem>
          ))}
          {value ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  // Let the menu close before the dialog takes the focus.
                  setTimeout(() => setOptionsOpen(true), 0);
                }}
                data-testid="model-options"
              >
                <SlidersHorizontalIcon />
                <span className="min-w-0 flex-1 truncate">{t("models.options")}</span>
                {custom ? <Badge variant="outline">{t("models.optionsCustom")}</Badge> : null}
              </DropdownMenuItem>
            </>
          ) : null}
          {others.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">{t("models.menuOthers")}</DropdownMenuLabel>
              {others.map((m) => (
                <DropdownMenuItem key={m.name} onSelect={() => navigate(`/models?model=${encodeURIComponent(m.name)}`)} data-testid={`catalog-option-${m.name}`}>
                  <MakerIcon model={m.name} className="size-4" />
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{m.sizes.slice(0, 3).join(" · ")}</span>
                  {deviceId ? <QuickDownload deviceId={deviceId} entry={m} onReady={onChange} /> : null}
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/models#catalog" data-testid="model-see-all">
              {t("models.menuSeeAll")}
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {value ? <ModelOptionsDialog model={value} open={optionsOpen} onOpenChange={setOptionsOpen} /> : null}
    </>
  );
}
