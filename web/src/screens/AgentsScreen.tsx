// Agents of the selected computer (rev. 1.8, SPEC §9.4): choose one or create a new one, edit it,
// "Use" starts a chat with it. `?id=` opens that agent. Unsaved changes are kept from being lost
// (switching agents or leaving the screen asks first).

import { useCallback, useState } from "react";
import { useBlocker, useNavigate, useSearchParams } from "react-router";
import { MessageSquarePlusIcon, PlusIcon } from "lucide-react";
import { startChatWithAgent } from "@/app/actions";
import { AgentAvatar } from "@/components/agents/AgentAvatar";
import { AgentEditor } from "@/components/agents/AgentEditor";
import { DiscardDialog, LibraryStatus, useLibraryDevice } from "@/components/agents/library-screen";
import { DevicePicker } from "@/components/chat/Pickers";
import { ScreenBody, ScreenHeader } from "@/components/layout/ScreenHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/i18n";
import { agentInput, newAgent } from "@/lib/agents";
import type { AgentInput } from "@/protocol/channel";
import { useModels, useSettings } from "@/stores/react";
import { settingsStore } from "@/stores/settings";

/** What the form shows: a saved agent, or one not saved yet (new or a copy). */
type Editing = { saved: true; id: string } | { saved: false; input: AgentInput; key: string } | null;

export function AgentsScreen() {
  const { t } = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const lib = useLibraryDevice({ withModels: true });
  const { deviceId, library } = lib;
  const models = useModels((s) => (deviceId ? s.byDevice[deviceId]?.models : undefined));
  const defaultModel = useSettings((s) => s.settings.default_model);

  const [editing, setEditing] = useState<Editing>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const onDirtyChange = useCallback((d: boolean) => setDirty(d), []);

  // A different computer: start over. Once its agents are in: the one of `?id=`, else the first.
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
    const first = (wanted && library.agents.find((a) => a.id === wanted)) || library.agents[0];
    if (first) setEditing({ saved: true, id: first.id });
  }

  // Leaving the screen with unsaved changes asks first.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  const guard = (action: () => void) => {
    if (dirty) setPending(() => action);
    else action();
  };
  const startNew = () =>
    guard(() => {
      const installed = models ?? [];
      const model = defaultModel && installed.some((m) => m.name === defaultModel) ? defaultModel : (installed[0]?.name ?? "");
      const input = newAgent(model);
      setEditing({ saved: false, input, key: input.id });
      setDirty(false);
    });
  const pick = (id: string) =>
    guard(() => {
      setEditing({ saved: true, id });
      setDirty(false);
    });

  const current = editing?.saved ? library.agents.find((a) => a.id === editing.id) : undefined;
  const initial = editing ? (editing.saved ? (current ? agentInput(current) : null) : editing.input) : null;
  const status = <LibraryStatus {...lib} testid="agents" />;
  const ready = deviceId && lib.reachable && library.loaded && library.supported !== false;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agents-screen">
      <ScreenHeader title={t("nav.agents")}>
        <DevicePicker value={deviceId} onChange={(id) => guard(() => void settingsStore.getState().update({ default_device_id: id }))} />
      </ScreenHeader>
      <ScreenBody>
        {!ready ? (
          status
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select value={editing?.saved ? editing.id : ""} onValueChange={pick}>
                <SelectTrigger className="h-9 w-full min-w-0 sm:flex-1" data-testid="agent-select">
                  <SelectValue placeholder={editing && !editing.saved ? t("agents.newTitle") : t("agents.select")} />
                </SelectTrigger>
                <SelectContent position="popper">
                  {library.agents.map((a) => (
                    <SelectItem key={a.id} value={a.id} data-testid="agent-select-option" data-name={a.name}>
                      <AgentAvatar icon={a.icon} />
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="lg" className="flex-1 sm:flex-none" onClick={startNew} data-testid="agent-new">
                  <PlusIcon />
                  {t("agents.create")}
                </Button>
                <Button
                  type="button"
                  size="lg"
                  className="flex-1 sm:flex-none"
                  disabled={!current || dirty}
                  onClick={() => current && deviceId && startChatWithAgent(navigate, deviceId, current.id)}
                  title={t("agents.useHint")}
                  data-testid="agent-use"
                >
                  <MessageSquarePlusIcon />
                  {t("agents.use")}
                </Button>
              </div>
            </div>

            {editing && !editing.saved ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="outline">{t("agents.unsaved")}</Badge>
              </div>
            ) : null}

            {initial && deviceId ? (
              <AgentEditor
                key={editing?.saved ? editing.id : (editing?.key ?? "none")}
                deviceId={deviceId}
                initial={initial}
                saved={Boolean(editing?.saved)}
                onDirtyChange={onDirtyChange}
                onSaved={(agent) => {
                  setDirty(false);
                  setEditing({ saved: true, id: agent.id });
                }}
                onDeleted={() => {
                  setDirty(false);
                  const gone = editing?.saved ? editing.id : null;
                  const next = library.agents.find((a) => a.id !== gone);
                  setEditing(next ? { saved: true, id: next.id } : null);
                }}
                onDuplicate={(copy) => {
                  setDirty(false);
                  setEditing({ saved: false, input: copy, key: copy.id });
                }}
              />
            ) : library.agents.length === 0 ? (
              <div className="rounded-xl border border-dashed p-8 text-center" data-testid="agents-empty">
                <p className="font-medium">{t("agents.empty", { device: lib.device?.name ?? "" })}</p>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{t("agents.emptyHint")}</p>
                <Button type="button" className="mt-4" onClick={startNew}>
                  <PlusIcon />
                  {t("agents.create")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </ScreenBody>
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
