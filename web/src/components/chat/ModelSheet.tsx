// Phone: the model pill inside the composer box and the sheet it opens from the bottom ("Select
// model"): the computer the chat runs on (fixed once the chat exists), the computer's installed
// models, thinking (only for models that advertise it), the per-model settings, and other models
// from the Ollama library. The desktop keeps its pickers in the row under the box (Pickers.tsx,
// ModelMenu.tsx, ThinkToggle.tsx).

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { CheckIcon, ChevronRightIcon, Loader2Icon, XIcon } from "lucide-react";
import { cn } from "cn";
import { phoneCard, phoneCardLabel, phoneRow, phoneSurface, roundButton } from "@/components/layout/phone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/i18n";
import { formatBytes, formatParams, MODEL_LOCALE } from "@/lib/format";
import { familyOf } from "@/lib/makers";
import { hasCustomOptions } from "@/lib/model-options";
import { catalogStore } from "@/stores/catalog";
import { useCatalog, useDevices, useModels, useSettings } from "@/stores/react";
import { QuickDownload } from "@/components/models/Downloads";
import { MakerIcon } from "./MakerIcon";
import { ModelOptionsDialog } from "./ModelOptionsDialog";
import { OnlineDot } from "./Pickers";

const OTHERS_SHOWN = 6;

export interface ModelSheetProps {
  deviceId: string | null;
  /** The chat exists: its computer can no longer change. */
  deviceLocked: boolean;
  onDeviceChange(id: string): void;
  model: string | null;
  onModelChange(name: string): void;
  /** An agent brings its own model: the pill shows it, disabled. */
  disabled: boolean;
  /** Thinking on/off, for models that advertise it (null: no row). */
  think: { on: boolean; onChange(v: boolean): void } | null;
}

export function ModelSheet({ deviceId, deviceLocked, onDeviceChange, model, onModelChange, disabled, think }: ModelSheetProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const entry = useModels((s) => (deviceId ? s.byDevice[deviceId] : undefined));
  const custom = useSettings((s) => (model ? hasCustomOptions(s.settings.model_options[model]) : false));
  const suffix = think?.on ? t("chat.think") : custom ? t("models.optionsCustom") : null;
  const loading = Boolean(entry?.loading && entry.models.length === 0);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="h-8 max-w-[44vw] min-w-0 shrink gap-1.5 overflow-hidden rounded-full bg-muted/80 px-3 text-[14px] font-normal hover:bg-muted"
        disabled={disabled || !deviceId}
        onClick={() => setOpen(true)}
        data-testid="model-picker"
        data-custom={custom ? "true" : "false"}
      >
        {loading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
        <span className="truncate">{model ?? t("chat.pickModel")}</span>
        {suffix ? <span className="shrink-0 text-muted-foreground">{suffix}</span> : null}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" showCloseButton={false} className={cn("max-h-[88dvh] gap-0 rounded-t-[28px] p-0 pb-safe data-[side=bottom]:border-t-0", phoneSurface)} data-testid="model-sheet">
          <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden />
          <div className="relative flex h-16 shrink-0 items-center justify-center px-4">
            <SheetClose asChild>
              <Button variant="ghost" size="icon" className={cn("absolute left-4", roundButton)} aria-label={t("common.close")} data-testid="model-sheet-close">
                <XIcon />
              </Button>
            </SheetClose>
            <SheetTitle className="text-[17px] font-semibold">{t("models.sheetTitle")}</SheetTitle>
            <SheetDescription className="sr-only">{t("models.sheetDescription")}</SheetDescription>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
            <ComputerCard deviceId={deviceId} locked={deviceLocked} onChange={onDeviceChange} />
            <ModelsCard
              deviceId={deviceId}
              value={model}
              onChange={(name) => {
                onModelChange(name);
                setOpen(false);
              }}
            />
            {think ? (
              <div className={phoneCard}>
                <label className={cn(phoneRow, "cursor-pointer")}>
                  <span className="min-w-0 flex-1">
                    <span className="block">{t("chat.think")}</span>
                    <span className="block text-[13px] text-muted-foreground">{t("chat.thinkHint")}</span>
                  </span>
                  <Switch checked={think.on} onCheckedChange={think.onChange} data-testid="think-toggle" />
                </label>
              </div>
            ) : null}
            <MoreCard
              deviceId={deviceId}
              model={model}
              onDownloaded={onModelChange}
              custom={custom}
              onOptions={() => {
                setOpen(false);
                // Let the sheet close before the dialog takes the focus.
                setTimeout(() => setOptionsOpen(true), 0);
              }}
              onLeave={() => setOpen(false)}
            />
          </div>
        </SheetContent>
      </Sheet>
      {model ? <ModelOptionsDialog model={model} open={optionsOpen} onOpenChange={setOptionsOpen} /> : null}
    </>
  );
}

/** The computer: every computer of the account while the chat is new, only its own afterwards. */
function ComputerCard({ deviceId, locked, onChange }: { deviceId: string | null; locked: boolean; onChange(id: string): void }) {
  const { t } = useT();
  const devices = useDevices((s) => s.devices);
  const order = useDevices((s) => s.order);
  const ids = locked ? order.filter((id) => id === deviceId) : order;
  return (
    <section data-testid="device-picker">
      <p className={phoneCardLabel}>{t("models.sheetComputer")}</p>
      <div className={phoneCard}>
        {ids.map((id) => {
          const d = devices[id];
          if (!d) return null;
          return (
            <button key={id} type="button" className={phoneRow} disabled={locked && id !== deviceId} onClick={() => onChange(id)} data-testid={`device-option-${id}`} aria-pressed={id === deviceId}>
              <OnlineDot online={d.online} />
              <span className="min-w-0 flex-1 truncate">{d.name || t("devices.unnamed")}</span>
              {!d.paired ? <Badge variant="outline">{t("devices.notPaired")}</Badge> : null}
              {id === deviceId ? <CheckIcon className="size-5 text-foreground" /> : null}
            </button>
          );
        })}
        {!locked ? (
          <Link to="/devices" className={cn(phoneRow, "text-muted-foreground")}>
            <span className="flex-1">{t("devices.manage")}</span>
            <ChevronRightIcon className="size-5 opacity-60" />
          </Link>
        ) : null}
      </div>
    </section>
  );
}

/** The computer's installed models, each with its parameters and size ("30.7B · 20.4 GB"; and "loaded" when in memory). */
function ModelsCard({ deviceId, value, onChange }: { deviceId: string | null; value: string | null; onChange(name: string): void }) {
  const { t } = useT();
  const entry = useModels((s) => (deviceId ? s.byDevice[deviceId] : undefined));
  const models = entry?.models ?? [];
  const running = new Set((entry?.running ?? []).map((m) => m.name));
  return (
    <section>
      <p className={phoneCardLabel}>{t("nav.models")}</p>
      <div className={phoneCard}>
        {models.length === 0 ? <p className="px-4 py-4 text-[15px] text-muted-foreground">{entry?.loading ? t("common.loading") : t("models.none")}</p> : null}
        {models.map((m) => {
          const meta = [formatParams(m.details.parameter_size), formatBytes(m.size, MODEL_LOCALE), running.has(m.name) ? t("models.loaded") : null].filter(Boolean).join(" · ");
          return (
            <button key={m.name} type="button" className={phoneRow} onClick={() => onChange(m.name)} data-testid={`model-option-${m.name}`}>
              <MakerIcon model={m.name} className="size-6" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{m.name}</span>
                {meta ? <span className="block truncate text-[13px] text-muted-foreground">{meta}</span> : null}
              </span>
              {m.name === value ? <CheckIcon className="size-5 text-foreground" /> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** "Model settings ›" and "Other models ›" (the library's most popular, then the full list). */
function MoreCard({
  deviceId,
  model,
  custom,
  onOptions,
  onLeave,
  onDownloaded,
}: {
  deviceId: string | null;
  model: string | null;
  custom: boolean;
  onOptions(): void;
  onLeave(): void;
  onDownloaded(name: string): void;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const catalog = useCatalog((s) => s.catalog);
  const [othersOpen, setOthersOpen] = useState(false);
  useEffect(() => {
    void catalogStore.getState().load();
  }, []);
  const models = useModels((s) => (deviceId ? s.byDevice[deviceId]?.models : undefined));
  const installed = new Set((models ?? []).map((m) => familyOf(m.name)));
  const others = (catalog?.models ?? []).filter((m) => !installed.has(m.name) && !m.capabilities.includes("embedding")).slice(0, OTHERS_SHOWN);
  return (
    <div className={phoneCard}>
      {model ? (
        <button type="button" className={phoneRow} onClick={onOptions} data-testid="model-options">
          <span className="min-w-0 flex-1 truncate">{t("models.sheetOptions")}</span>
          {custom ? <span className="text-[15px] text-muted-foreground">{t("models.optionsCustom")}</span> : null}
          <ChevronRightIcon className="size-5 opacity-60" />
        </button>
      ) : null}
      <button type="button" className={phoneRow} onClick={() => setOthersOpen((o) => !o)} aria-expanded={othersOpen} data-testid="model-others">
        <span className="min-w-0 flex-1 truncate">{t("models.menuOthers")}</span>
        <ChevronRightIcon className={cn("size-5 opacity-60 transition-transform", othersOpen && "rotate-90")} />
      </button>
      {othersOpen ? (
        <>
          {others.map((m) => (
            <div key={m.name} className={cn(phoneRow, "gap-2 py-2 pl-6 hover:bg-transparent")}>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                onClick={() => {
                  onLeave();
                  navigate(`/models?model=${encodeURIComponent(m.name)}`);
                }}
                data-testid={`catalog-option-${m.name}`}
              >
                <MakerIcon model={m.name} className="size-5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{m.name}</span>
                  <span className="block truncate text-[13px] text-muted-foreground">{m.sizes.slice(0, 3).join(" · ")}</span>
                </span>
              </button>
              {deviceId ? <QuickDownload deviceId={deviceId} entry={m} onReady={onDownloaded} /> : null}
            </div>
          ))}
          <Link to="/models#catalog" className={cn(phoneRow, "pl-6 text-muted-foreground")} onClick={onLeave} data-testid="model-see-all">
            {t("models.menuSeeAll")}
          </Link>
        </>
      ) : null}
    </div>
  );
}
