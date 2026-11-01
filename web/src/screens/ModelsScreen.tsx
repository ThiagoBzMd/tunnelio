// Models of the selected device: installed (delete), loaded (VRAM), and the Ollama library (server
// relay, daily) to browse and search. A click on a size downloads it (rev. 1.9), and the size says how
// big the download is once the server knows it; the download goes to the top of the installed list
// with its progress (components/models/Downloads.tsx); a model that is not in the library is
// downloaded by name at the end. `?model=NAME` (from the model menu) prefills the search and
// highlights that entry; `#catalog` scrolls to it.

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLocation, useSearchParams } from "react-router";
import { CheckIcon, DownloadIcon, Loader2Icon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { cn } from "cn";
import { toast } from "sonner";
import { MakerIcon } from "@/components/chat/MakerIcon";
import { DevicePicker } from "@/components/chat/Pickers";
import { PullRow, useStartPull } from "@/components/models/Downloads";
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
import { localeOf, useT, type TKey } from "@/i18n";
import { CATALOG_CAPABILITIES, catalogEntryFor, downloadSize, pullTargets, searchCatalog, type CatalogCapability } from "@/lib/catalog";
import { formatBytes, formatBytesRange, formatParams, MODEL_LOCALE, relativeTime } from "@/lib/format";
import { familyOf } from "@/lib/makers";
import { catalogStore } from "@/stores/catalog";
import { modelsStore } from "@/stores/models";
import { useCatalog, useDevices, useModels, useSettings } from "@/stores/react";
import { settingsStore } from "@/stores/settings";

// SPEC §8.2: strict `family:tag` or `namespace/family:tag`, tag mandatory, no digests.
const PULL_NAME = /^([a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CAP_LABEL: Record<CatalogCapability, TKey> = { vision: "models.capVision", tools: "models.capTools", thinking: "models.capThinking", embedding: "models.capEmbedding" };
const CATALOG_PAGE = 30;

export function ModelsScreen() {
  const { t, lang } = useT();
  const devices = useDevices((s) => s.devices);
  const order = useDevices((s) => s.order);
  const defaultDevice = useSettings((s) => s.settings.default_device_id);
  const deviceId = defaultDevice && devices[defaultDevice] ? defaultDevice : (order.find((id) => devices[id]?.paired && devices[id]?.online) ?? order[0] ?? null);
  const device = deviceId ? devices[deviceId] : undefined;
  const entry = useModels((s) => (deviceId ? s.byDevice[deviceId] : undefined));
  const [pullName, setPullName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const locale = localeOf(lang);
  const installedRef = useRef<HTMLElement>(null);
  const startPull = useStartPull();

  // The library: cached a day in the browser, refreshed daily on the server.
  const loc = useLocation();
  const [searchParams] = useSearchParams();
  const preset = searchParams.get("model");
  const catalog = useCatalog((s) => s.catalog);
  const catalogLoading = useCatalog((s) => s.loading);
  const [query, setQuery] = useState(preset ?? "");
  const [caps, setCaps] = useState<CatalogCapability[]>([]);
  const [limit, setLimit] = useState(CATALOG_PAGE);
  const catalogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    void catalogStore.getState().load();
  }, []);
  useEffect(() => {
    if (catalog && (loc.hash === "#catalog" || preset)) catalogRef.current?.scrollIntoView({ block: "start" });
  }, [catalog, loc.hash, preset]);
  const results = useMemo(() => (catalog ? searchCatalog(catalog.models, query, caps) : []), [catalog, query, caps]);

  const reachable = Boolean(device?.paired && device.online);
  const refresh = () => {
    if (!deviceId || !reachable) return;
    void Promise.all([modelsStore.getState().list(deviceId), modelsStore.getState().listRunning(deviceId)]);
  };
  useEffect(refresh, [deviceId, reachable]);

  /** One click: the download starts and shows up at the top of the installed list. */
  const download = (name: string) => {
    if (!deviceId || !PULL_NAME.test(name)) return;
    void startPull(deviceId, name, refresh);
    installedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const pullByName = (e: FormEvent) => {
    e.preventDefault();
    const name = pullName.trim();
    if (!PULL_NAME.test(name)) return;
    setPullName("");
    download(name);
  };

  // Downloads that are on (or ended without the model): above the installed models.
  const pulls = Object.values(entry?.pulls ?? {}).filter((p) => !p.done || p.error || p.canceled);
  const pulling = new Set(Object.values(entry?.pulls ?? {}).filter((p) => !p.done && !p.canceled).map((p) => p.name));
  const installedNames = new Set((entry?.models ?? []).map((m) => m.name));
  const running = new Map((entry?.running ?? []).map((m) => [m.name, m]));
  const installedFamilies = new Set((entry?.models ?? []).map((m) => familyOf(m.name)));

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="models-screen">
      <ScreenHeader
        title={t("nav.models")}
        actions={
          <Button variant="ghost" size="icon-sm" onClick={refresh} disabled={!reachable || entry?.loading} aria-label={t("common.refresh")} data-testid="models-refresh">
            <RefreshCwIcon className={entry?.loading ? "animate-spin" : ""} />
          </Button>
        }
      >
        <DevicePicker value={deviceId} onChange={(id) => void settingsStore.getState().update({ default_device_id: id })} />
      </ScreenHeader>
      <ScreenBody>
        {!deviceId ? (
          <p className="text-sm text-muted-foreground">{t("chat.noDevices")}</p>
        ) : !reachable ? (
          <p className="text-sm text-muted-foreground" data-testid="models-unreachable">
            {device?.paired ? t("chat.deviceOffline", { name: device.name }) : t("chat.deviceNotPaired")}
          </p>
        ) : (
          <>
            <section ref={installedRef} className="scroll-mt-4">
              <h2 className="mb-2 font-medium">{t("models.installed", { n: entry?.models.length ?? 0 })}</h2>
              {entry?.error ? <p className="text-sm text-destructive">{entry.error}</p> : null}
              {pulls.length > 0 && deviceId ? (
                <ul className="mb-2 grid gap-2" data-testid="pull-list">
                  {pulls.map((p) => (
                    <PullRow key={p.name} deviceId={deviceId} pull={p} />
                  ))}
                </ul>
              ) : null}
              {entry && entry.models.length === 0 && !entry.loading && pulls.length === 0 ? <p className="text-sm text-muted-foreground">{t("models.none")}</p> : null}
              <ul className="grid gap-2" data-testid="model-list">
                {(entry?.models ?? []).map((m) => {
                  const r = running.get(m.name);
                  // Same card as the library below: logo, capability tags and description come from the library entry.
                  const lib = catalog ? catalogEntryFor(catalog.models, m.name) : undefined;
                  return (
                    <li key={m.name} className="flex items-start gap-3 rounded-xl border bg-card p-3" data-testid="model-item" data-name={m.name}>
                      <MakerIcon model={m.name} className="mt-0.5 size-6" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-medium">{m.name}</span>
                          {r ? (
                            <Badge variant="secondary" data-testid="model-loaded">
                              {t("models.loaded")}
                            </Badge>
                          ) : null}
                          {(lib?.capabilities ?? []).map((c) => (
                            <Badge key={c} variant="outline">
                              {(CAP_LABEL as Record<string, TKey | undefined>)[c] ? t((CAP_LABEL as Record<string, TKey>)[c] as TKey) : c}
                            </Badge>
                          ))}
                        </div>
                        {lib?.description ? <p className="mt-0.5 text-sm text-muted-foreground">{lib.description}</p> : null}
                        <p className="mt-1 text-xs text-muted-foreground">
                          {[formatBytes(m.size, MODEL_LOCALE), m.details.family, formatParams(m.details.parameter_size), m.details.quantization_level, t("models.modified", { when: relativeTime(m.modified_at, locale) })]
                            .filter(Boolean)
                            .join(" · ")}
                          {r ? ` · ${t("models.vram", { size: formatBytes(r.size_vram, MODEL_LOCALE) })}` : ""}
                        </p>
                      </div>
                      <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(m.name)} aria-label={t("common.delete")} data-testid="model-delete">
                        <Trash2Icon />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section ref={catalogRef} id="catalog" className="scroll-mt-4" data-testid="catalog">
              <h2 className="font-medium">{t("models.catalogTitle")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("models.catalogHint")}
                {catalog?.fetched_at ? ` ${t("models.catalogUpdated", { when: relativeTime(catalog.fetched_at, locale) })}` : ""}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setLimit(CATALOG_PAGE);
                  }}
                  placeholder={t("models.catalogSearch")}
                  className="max-w-xs"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  data-testid="catalog-search"
                />
                {CATALOG_CAPABILITIES.map((c) => (
                  <Button
                    key={c}
                    type="button"
                    variant={caps.includes(c) ? "secondary" : "outline"}
                    size="xs"
                    aria-pressed={caps.includes(c)}
                    onClick={() => {
                      setCaps(caps.includes(c) ? caps.filter((x) => x !== c) : [...caps, c]);
                      setLimit(CATALOG_PAGE);
                    }}
                    data-testid={`catalog-filter-${c}`}
                  >
                    {t(CAP_LABEL[c])}
                  </Button>
                ))}
              </div>
              {!catalog ? (
                <p className="mt-3 text-sm text-muted-foreground" data-testid="catalog-unavailable">
                  {catalogLoading ? t("common.loading") : t("models.catalogUnavailable")}
                </p>
              ) : results.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground" data-testid="catalog-empty">
                  {t("models.catalogEmpty")}
                </p>
              ) : (
                <ul className="mt-3 grid gap-2" data-testid="catalog-list">
                  {results.slice(0, limit).map((m) => (
                    <li key={m.name} className={cn("rounded-xl border bg-card p-3", preset === m.name && "ring-2 ring-ring")} data-testid="catalog-item" data-name={m.name}>
                      <div className="flex items-start gap-3">
                        <MakerIcon model={m.name} className="mt-0.5 size-6" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm font-medium">{m.name}</span>
                            {installedFamilies.has(m.name) ? <Badge variant="secondary">{t("models.catalogInstalled")}</Badge> : null}
                            {m.capabilities.map((c) => (
                              <Badge key={c} variant="outline">
                                {(CAP_LABEL as Record<string, TKey | undefined>)[c] ? t((CAP_LABEL as Record<string, TKey>)[c] as TKey) : c}
                              </Badge>
                            ))}
                          </div>
                          {m.description ? <p className="mt-0.5 text-sm text-muted-foreground">{m.description}</p> : null}
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {pullTargets(m).map((target) => {
                              const have = installedNames.has(target);
                              const busy = pulling.has(target);
                              const tag = target.slice(m.name.length + 1);
                              const bytes = downloadSize(m, tag);
                              return (
                                <Button
                                  key={target}
                                  type="button"
                                  variant="outline"
                                  size="xs"
                                  className="font-mono"
                                  disabled={have || busy}
                                  onClick={() => download(target)}
                                  title={have ? t("models.sizeInstalled") : t("models.downloadModel", { name: target })}
                                  data-testid="catalog-size"
                                  data-target={target}
                                  data-state={have ? "installed" : busy ? "downloading" : "available"}
                                >
                                  {have ? <CheckIcon /> : busy ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
                                  {tag}
                                  {bytes ? (
                                    <span className="font-sans text-muted-foreground" data-testid="catalog-size-bytes">
                                      · {formatBytesRange(bytes[0], bytes[1], MODEL_LOCALE)}
                                    </span>
                                  ) : null}
                                </Button>
                              );
                            })}
                            <span className="ml-auto text-[11px] text-muted-foreground">
                              {[m.pulls_text ? t("models.pulls", { n: m.pulls_text }) : "", m.updated_text].filter(Boolean).join(" · ")}
                            </span>
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {results.length > limit ? (
                <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setLimit(limit + CATALOG_PAGE)} data-testid="catalog-more">
                  {t("models.showMore")}
                </Button>
              ) : null}
              <div className="mt-6 rounded-xl border bg-card p-4">
                <h3 className="text-sm font-medium">{t("models.pullByName")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t("models.pullByNameHint")}</p>
                <form onSubmit={pullByName} className="mt-3 flex gap-2">
                  <Input value={pullName} onChange={(e) => setPullName(e.target.value)} placeholder="llama3.2:3b" className="font-mono" autoCapitalize="none" autoCorrect="off" spellCheck={false} data-testid="pull-input" />
                  <Button type="submit" disabled={!PULL_NAME.test(pullName.trim())} data-testid="pull-submit">
                    <DownloadIcon />
                    {t("models.pull")}
                  </Button>
                </form>
                {pullName.trim() && !PULL_NAME.test(pullName.trim()) ? <p className="mt-1 text-xs text-destructive">{t("models.pullNameInvalid")}</p> : null}
              </div>
            </section>
          </>
        )}
      </ScreenBody>
      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => (o ? undefined : setConfirmDelete(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("models.deleteTitle", { name: confirmDelete ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("models.deleteDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const name = confirmDelete;
                if (!deviceId || !name) return;
                void modelsStore
                  .getState()
                  .remove(deviceId, name)
                  .then((ok) => (ok ? toast.success(t("models.deleted", { name })) : toast.error(t("models.deleteFailed"))));
              }}
              data-testid="model-delete-confirm"
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
