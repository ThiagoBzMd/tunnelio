// Model downloads (rev. 1.9): one click starts one (useStartPull); a downloading, queued, failed or
// canceled model sits at the top of the installed list with its progress (PullRow); the sidebar
// shows what is downloading from any screen (DownloadsIndicator). The computer does the download
// and finishes it even when the browser leaves (SPEC §7.6).

import { useMemo } from "react";
import { Link } from "react-router";
import { DownloadIcon, Loader2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { MakerIcon } from "@/components/chat/MakerIcon";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useT } from "@/i18n";
import { downloadSize, quickTarget, type CatalogModel } from "@/lib/catalog";
import { formatBytes, formatBytesRange, MODEL_LOCALE } from "@/lib/format";
import { modelsStore, type PullState } from "@/stores/models";
import { useModels } from "@/stores/react";

/** Percent done, when the computer has said how big it is. */
export function pullPercent(p: PullState): number | null {
  return p.total && p.completed !== null ? Math.min(100, Math.round((p.completed / p.total) * 100)) : null;
}

/** Starts a download with one click; says when it is ready or failed; `onReady` runs once it is installed. */
export function useStartPull() {
  const { t } = useT();
  return (deviceId: string, name: string, onReady?: (name: string) => void) =>
    modelsStore
      .getState()
      .pull(deviceId, name)
      .then((ok) => {
        if (ok) {
          toast.success(t("models.pulled", { name }));
          onReady?.(name);
        } else if (!modelsStore.getState().byDevice[deviceId]?.pulls[name]?.canceled) toast.error(t("models.pullFailed", { name }));
        return ok;
      });
}

/** The status of a download in words: queued, canceled, failed, or the bytes so far. */
function usePullStatus(p: PullState): string {
  const { t } = useT();
  if (p.canceled) return t("models.pullCanceled");
  if (p.error) return p.error.startsWith("E_PULL_BUSY") ? t("models.pullBusy") : t("models.pullFailedShort");
  if (p.queued) return t("models.pullQueued");
  if (p.total && p.completed !== null) return `${formatBytes(p.completed, MODEL_LOCALE)} / ${formatBytes(p.total, MODEL_LOCALE)}`;
  return t("models.pullStarting");
}

/** A download in the installed list: logo, name, progress, cancel (or dismiss once it ended). */
export function PullRow({ deviceId, pull }: { deviceId: string; pull: PullState }) {
  const { t } = useT();
  const status = usePullStatus(pull);
  const pct = pullPercent(pull);
  const ended = pull.done || pull.canceled;
  return (
    <li className="flex items-start gap-3 rounded-xl border border-dashed bg-card p-3" data-testid="pull-item" data-name={pull.name} data-done={pull.done} data-queued={pull.queued ? "true" : "false"}>
      <MakerIcon model={pull.name} className="mt-0.5 size-6" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-sm font-medium">{pull.name}</span>
          <span className={pull.error ? "text-xs text-destructive" : "text-xs text-muted-foreground tabular-nums"}>{status}</span>
        </div>
        {!ended ? (
          <div className="mt-2 flex items-center gap-2">
            {pct === null ? <Loader2Icon className="size-4 animate-spin text-muted-foreground" /> : <Progress value={pct} className="h-1.5" />}
            {pct !== null ? <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">{pct}%</span> : null}
          </div>
        ) : null}
        {pull.error && !pull.error.startsWith("E_PULL_BUSY") ? <p className="mt-1 truncate text-xs text-destructive">{pull.error}</p> : null}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => (ended ? modelsStore.getState().dismissPull(deviceId, pull.name) : void modelsStore.getState().cancelPull(deviceId, pull.name))}
        aria-label={ended ? t("models.pullDismiss") : t("models.pullCancel")}
        data-testid={ended ? "pull-dismiss" : "pull-cancel"}
      >
        <XIcon />
      </Button>
    </li>
  );
}

/** The sidebar row while something downloads (any screen): name, percent; opens the Models screen. */
export function DownloadsIndicator({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  const { t } = useT();
  const byDevice = useModels((s) => s.byDevice);
  const active = useMemo(
    () =>
      Object.values(byDevice)
        .flatMap((d) => Object.values(d.pulls))
        .filter((p) => !p.done && !p.canceled),
    [byDevice],
  );
  if (active.length === 0) return null;
  const first = active.find((p) => !p.queued) ?? active[0];
  if (!first) return null;
  const pct = pullPercent(first);
  return (
    <Link to="/models" onClick={onNavigate} className="mx-2 mt-3 block rounded-lg border bg-background/60 px-3 py-2 text-[13px] hover:bg-sidebar-accent" data-testid="downloads-indicator">
      <span className="flex items-center gap-2">
        <DownloadIcon className="size-4 shrink-0 animate-pulse text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{t("models.downloading", { name: first.name })}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{pct !== null ? `${pct}%` : "…"}</span>
      </span>
      {pct !== null ? <Progress value={pct} className="mt-1.5 h-1" /> : null}
      {active.length > 1 ? <span className="mt-1 block text-xs text-muted-foreground">{t("models.downloadsMore", { n: active.length - 1 })}</span> : null}
    </Link>
  );
}

/**
 * The download button of a library model in the chat's model menu: one click downloads the size
 * Ollama itself recommends (quickTarget: its "latest" tag), with how big it is when known; shows
 * the progress; `onReady` selects it once installed.
 */
export function QuickDownload({ deviceId, entry, onReady }: { deviceId: string; entry: CatalogModel; onReady?: ((name: string) => void) | undefined }) {
  const { t } = useT();
  const name = quickTarget(entry);
  const bytes = downloadSize(entry, name.slice(entry.name.length + 1));
  const pull = useModels((s) => s.byDevice[deviceId]?.pulls[name]);
  const start = useStartPull();
  const active = Boolean(pull && !pull.done && !pull.canceled);
  const pct = pull ? pullPercent(pull) : null;
  return (
    <button
      type="button"
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border bg-background px-2 text-xs text-foreground/90 transition-colors hover:bg-accent disabled:opacity-70"
      disabled={active}
      onClick={(e) => {
        // Inside a menu item: download only, without opening the Models screen.
        e.stopPropagation();
        e.preventDefault();
        void start(deviceId, name, onReady);
      }}
      aria-label={t("models.downloadModel", { name })}
      data-testid={`quick-download-${entry.name}`}
      data-target={name}
      data-state={active ? "downloading" : "available"}
    >
      {active ? <Loader2Icon className="size-3.5 animate-spin" /> : <DownloadIcon className="size-3.5" />}
      {active ? (pull?.queued ? t("models.pullQueued") : pct !== null ? `${pct}%` : "…") : t("models.download")}
      {!active && bytes ? <span className="text-muted-foreground">· {formatBytesRange(bytes[0], bytes[1], MODEL_LOCALE)}</span> : null}
    </button>
  );
}
