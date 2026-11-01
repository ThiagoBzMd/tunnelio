// Skills of the selected computer (rev. 1.8, SPEC §9.4): the list on the left (filter by name, "+"),
// the editor on the right; on a phone the list, then the editor with a way back. `?id=` opens
// that skill. Unsaved changes are kept from being lost.

import { useCallback, useMemo, useState } from "react";
import { useBlocker, useSearchParams } from "react-router";
import { ChevronLeftIcon, PlusIcon } from "lucide-react";
import { cn } from "cn";
import { SkillIcon } from "@/components/agents/AgentAvatar";
import { DiscardDialog, LibraryStatus, useLibraryDevice } from "@/components/agents/library-screen";
import { SkillEditor } from "@/components/agents/SkillEditor";
import { DevicePicker } from "@/components/chat/Pickers";
import { ScreenBody, ScreenHeader } from "@/components/layout/ScreenHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { newSkill, skillInput } from "@/lib/agents";
import type { SkillInput } from "@/protocol/channel";
import { settingsStore } from "@/stores/settings";

type Editing = { saved: true; id: string } | { saved: false; input: SkillInput } | null;

export function SkillsScreen() {
  const { t } = useT();
  const [params] = useSearchParams();
  const lib = useLibraryDevice();
  const { deviceId, library } = lib;
  const [editing, setEditing] = useState<Editing>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [query, setQuery] = useState("");
  const onDirtyChange = useCallback((d: boolean) => setDirty(d), []);

  const [shownFor, setShownFor] = useState<string | null>(null);
  const [autoPicked, setAutoPicked] = useState(false);
  if (deviceId !== shownFor) {
    setShownFor(deviceId);
    setEditing(null);
    setDirty(false);
    setAutoPicked(false);
  }
  const wanted = params.get("id");
  if (!autoPicked && !editing && library.loaded && shownFor === deviceId) {
    setAutoPicked(true);
    if (wanted && library.skills.some((k) => k.id === wanted)) setEditing({ saved: true, id: wanted });
  }

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  const guard = (action: () => void) => {
    if (dirty) setPending(() => action);
    else action();
  };
  const go = (next: Editing) =>
    guard(() => {
      setEditing(next);
      setDirty(false);
    });

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return q ? library.skills.filter((k) => k.name.toLocaleLowerCase().includes(q)) : library.skills;
  }, [library.skills, query]);
  const current = editing?.saved ? library.skills.find((k) => k.id === editing.id) : undefined;
  const initial = editing ? (editing.saved ? (current ? skillInput(current) : null) : editing.input) : null;
  const ready = deviceId && lib.reachable && library.loaded && library.supported !== false;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="skills-screen">
      <ScreenHeader title={t("nav.skills")}>
        <DevicePicker value={deviceId} onChange={(id) => guard(() => void settingsStore.getState().update({ default_device_id: id }))} />
      </ScreenHeader>
      {!ready ? (
        <ScreenBody>
          <LibraryStatus {...lib} testid="skills" />
        </ScreenBody>
      ) : (
        <div className="flex min-h-0 flex-1 border-t">
          <aside className={cn("flex w-full min-w-0 flex-col md:w-72 md:shrink-0 md:border-r", editing && "hidden md:flex")} data-testid="skill-list">
            <div className="flex gap-2 p-3">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("skills.filter")}
                aria-label={t("skills.filter")}
                className="h-9 min-w-0 flex-1 rounded-lg border bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
                data-testid="skill-filter"
              />
              <Button type="button" variant="outline" size="icon-lg" onClick={() => go({ saved: false, input: newSkill() })} aria-label={t("skills.new")} data-testid="skill-new">
                <PlusIcon />
              </Button>
            </div>
            <p className="px-4 pb-1 text-xs font-medium text-muted-foreground">{t("skills.mine")}</p>
            <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {shown.map((k) => (
                <li key={k.id}>
                  <button
                    type="button"
                    onClick={() => go({ saved: true, id: k.id })}
                    className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent", editing?.saved && editing.id === k.id && "bg-accent")}
                    data-testid="skill-row"
                    data-name={k.name}
                  >
                    <SkillIcon category={k.category} />
                    <span className="min-w-0 flex-1 truncate">{k.name}</span>
                  </button>
                </li>
              ))}
              {library.skills.length === 0 ? (
                <li className="space-y-1 px-2.5 py-2 text-sm text-muted-foreground" data-testid="skills-empty">
                  <p>{t("skills.empty", { device: lib.device?.name ?? "" })}</p>
                  <p className="text-xs">{t("skills.emptyHint")}</p>
                </li>
              ) : null}
            </ul>
          </aside>
          <main className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto", !editing && "hidden md:block")}>
            <div className="mx-auto w-full max-w-3xl space-y-4 p-4 pb-safe md:p-6">
              {editing ? (
                <div className="flex items-center gap-2">
                  <Button type="button" variant="ghost" size="sm" className="-ml-2 md:hidden" onClick={() => go(null)} data-testid="skill-back">
                    <ChevronLeftIcon />
                    {t("skills.back")}
                  </Button>
                  {!editing.saved ? <Badge variant="outline">{t("agents.unsaved")}</Badge> : null}
                </div>
              ) : null}
              {initial && deviceId ? (
                <SkillEditor
                  key={editing?.saved ? editing.id : initial.id}
                  deviceId={deviceId}
                  initial={initial}
                  saved={Boolean(editing?.saved)}
                  onDirtyChange={onDirtyChange}
                  onSaved={(skill) => {
                    setDirty(false);
                    setEditing({ saved: true, id: skill.id });
                  }}
                  onDeleted={() => {
                    setDirty(false);
                    setEditing(null);
                  }}
                />
              ) : (
                <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                  <p>{library.skills.length === 0 ? t("skills.emptyHint") : t("skills.pick")}</p>
                  <Button type="button" className="mt-4" onClick={() => go({ saved: false, input: newSkill() })}>
                    <PlusIcon />
                    {t("skills.new")}
                  </Button>
                </div>
              )}
            </div>
          </main>
        </div>
      )}
      <DiscardDialog
        open={pending !== null || blocker.state === "blocked"}
        onCancel={() => {
          setPending(null);
          if (blocker.state === "blocked") blocker.reset();
        }}
        onDiscard={() => {
          const action = pending;
          setPending(null);
          setDirty(false);
          if (blocker.state === "blocked") blocker.proceed();
          else action?.();
        }}
      />
    </div>
  );
}
