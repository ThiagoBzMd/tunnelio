// One agent's form (SPEC §9.4): icon, name, description; model with its settings and thinking
// right under it; instructions (with a larger window to write them); skills Off / All /
// Selected; Advanced → Chain (ChainSection.tsx); delete, duplicate, save. Everything is checked
// here before it goes to the computer.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { BrainIcon, CopyPlusIcon, Loader2Icon, Maximize2Icon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { MakerIcon } from "@/components/chat/MakerIcon";
import { ModelOptionFields, OPTION_LABEL, optionTexts, readOptionFields, type OptionTexts } from "@/components/chat/ModelOptionFields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n";
import { duplicateAgent } from "@/lib/agents";
import type { Agent, AgentInput } from "@/protocol/channel";
import { LIMITS, type SkillsMode } from "@/protocol/constants";
import { libraryStore } from "@/stores/library";
import { modelsStore } from "@/stores/models";
import { useDevices, useLibrary, useModels } from "@/stores/react";
import { errorMessage } from "@/stores/util";
import { SkillIcon } from "./AgentAvatar";
import { ChainSection } from "./ChainSection";
import { ConfirmDelete } from "./library-screen";
import { IconPicker, Segmented, SkillPickerDialog } from "./pickers";

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

export interface AgentEditorProps {
  deviceId: string;
  initial: AgentInput;
  /** The agent exists on the computer (else: new or a copy, not saved yet). */
  saved: boolean;
  onSaved(agent: Agent): void;
  onDeleted(): void;
  /** A copy to edit (not saved yet). */
  onDuplicate(copy: AgentInput): void;
  /** Unsaved work in the form (the screen asks before throwing it away). */
  onDirtyChange(dirty: boolean): void;
}

export function AgentEditor({ deviceId, initial, saved, onSaved, onDeleted, onDuplicate, onDirtyChange }: AgentEditorProps) {
  const { t } = useT();
  const deviceName = useDevices((s) => s.devices[deviceId]?.name) ?? "";
  const skills = useLibrary((s) => s.byDevice[deviceId]?.skills) ?? [];
  const agents = useLibrary((s) => s.byDevice[deviceId]?.agents) ?? [];
  const agentCount = useLibrary((s) => s.byDevice[deviceId]?.agents.length ?? 0);
  const models = useModels((s) => s.byDevice[deviceId]?.models) ?? [];
  const modelsLoaded = useModels((s) => s.byDevice[deviceId]?.loaded_at != null);

  const [draft, setDraft] = useState<AgentInput>(initial);
  const [texts, setTexts] = useState<OptionTexts>(() => optionTexts(initial.options));
  const [busy, setBusy] = useState(false);
  const [expand, setExpand] = useState(false);
  const [picking, setPicking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const baseline = useMemo(() => JSON.stringify({ a: initial, o: optionTexts(initial.options) }), [initial]);
  const changed = JSON.stringify({ a: draft, o: texts }) !== baseline;
  const dirty = changed || (!saved && draft.name.trim() !== "");
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  // Thinking only for models that advertise it (show_model, cached per computer and model).
  const info = useModels((s) => (draft.model ? s.byDevice[deviceId]?.info[draft.model] : undefined));
  useEffect(() => {
    if (draft.model && !modelsStore.getState().byDevice[deviceId]?.info[draft.model]) void modelsStore.getState().show(deviceId, draft.model).catch(() => undefined);
  }, [deviceId, draft.model]);
  const canThink = Boolean(info?.capabilities?.includes("thinking"));
  const installed = models.some((m) => m.name === draft.model);

  const set = (patch: Partial<AgentInput>) => setDraft((d) => ({ ...d, ...patch }));
  const selectedSkills = draft.skill_ids.map((id) => skills.find((k) => k.id === id)).filter((k): k is NonNullable<typeof k> => Boolean(k));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const name = draft.name.trim();
    if (!name) return void toast.error(t("agents.nameRequired"));
    if (!draft.model) return void toast.error(t("agents.modelRequired"));
    const read = readOptionFields(texts);
    if ("invalid" in read) {
      return void toast.error(t("models.optionsInvalid", { field: t(OPTION_LABEL[read.invalid.key]), min: read.invalid.min, max: read.invalid.max }));
    }
    if (utf8Len(draft.instructions) > LIMITS.INSTRUCTIONS_MAX_BYTES) return void toast.error(t("agents.instructionsTooLong"));
    if (!saved && agentCount >= LIMITS.MAX_AGENTS) return void toast.error(t("agents.limit", { max: LIMITS.MAX_AGENTS }));
    const input: AgentInput = { ...draft, name, skill_ids: draft.skill_ids.filter((id) => skills.some((k) => k.id === id)) };
    // Only agents this computer still has; an older Tunnelio ignores the field.
    input.chain = (draft.chain ?? []).filter((id) => id !== draft.id && agents.some((a) => a.id === id));
    if (Object.keys(read.options).length > 0) input.options = read.options;
    else delete input.options;
    if (canThink) input.think = Boolean(draft.think);
    else delete input.think;
    setBusy(true);
    try {
      const agent = await libraryStore.getState().saveAgent(deviceId, input);
      toast.success(t("agents.saved"));
      onSaved(agent);
    } catch (err) {
      toast.error(t("agents.saveFailed", { error: errorMessage(err) }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await libraryStore.getState().deleteAgent(deviceId, draft.id);
      toast.success(t("agents.deleted"));
      onDeleted();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const modes: { value: SkillsMode; label: string }[] = [
    { value: "off", label: t("agents.skillsOff") },
    { value: "all", label: t("agents.skillsAll") },
    { value: "selected", label: t("agents.skillsSelected") },
  ];

  return (
    <form onSubmit={(e) => void save(e)} className="space-y-4" data-testid="agent-editor" data-saved={saved ? "true" : "false"}>
      <section className="rounded-xl border bg-card p-4">
        <div className="flex items-start gap-4">
          <IconPicker value={draft.icon} onChange={(icon) => set({ icon })} />
          <div className="min-w-0 flex-1 space-y-2">
            <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder={t("agents.namePlaceholder")} aria-label={t("agents.name")} maxLength={LIMITS.NAME_MAX_CHARS} data-testid="agent-name" />
            <Input
              value={draft.description}
              onChange={(e) => set({ description: e.target.value })}
              placeholder={t("agents.descriptionPlaceholder")}
              aria-label={t("agents.description")}
              maxLength={LIMITS.AGENT_DESCRIPTION_MAX_CHARS}
              data-testid="agent-description"
            />
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-xl border bg-card p-4">
        <div className="space-y-1.5">
          <Label>
            {t("agents.model")} <span className="text-destructive">*</span>
          </Label>
          <Select value={draft.model} onValueChange={(model) => set({ model })}>
            <SelectTrigger className="h-9 w-full" data-testid="agent-model">
              <SelectValue placeholder={t("agents.modelPlaceholder")} />
            </SelectTrigger>
            <SelectContent position="popper">
              {!installed && draft.model ? (
                <SelectItem value={draft.model}>
                  <MakerIcon model={draft.model} className="size-4" />
                  {draft.model}
                </SelectItem>
              ) : null}
              {models.map((m) => (
                <SelectItem key={m.name} value={m.name} data-testid={`agent-model-${m.name}`}>
                  <MakerIcon model={m.name} className="size-4" />
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {modelsLoaded && models.length === 0 ? <p className="text-xs text-muted-foreground">{t("agents.modelNone")}</p> : null}
          {modelsLoaded && draft.model && !installed ? <p className="text-xs text-destructive">{t("agents.modelNotInstalled", { model: draft.model, device: deviceName })}</p> : null}
        </div>
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">{t("agents.parameters")}</p>
            <p className="text-xs text-muted-foreground">{t("agents.parametersHint")}</p>
          </div>
          <ModelOptionFields values={texts} onChange={setTexts} idPrefix="agent-option" columns={3} />
        </div>
        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium">
              <BrainIcon className="size-4 text-muted-foreground" />
              {t("agents.think")}
            </p>
            <p className="text-xs text-muted-foreground">{canThink || !draft.model ? t("agents.thinkHint") : t("agents.thinkUnsupported")}</p>
          </div>
          <Switch checked={canThink && Boolean(draft.think)} disabled={!canThink} onCheckedChange={(on) => set({ think: on })} aria-label={t("agents.think")} data-testid="agent-think" />
        </div>
      </section>

      <section className="rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="agent-instructions">{t("agents.instructions")}</Label>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => setExpand(true)} aria-label={t("agents.instructionsExpand")} data-testid="agent-instructions-expand">
            <Maximize2Icon />
          </Button>
        </div>
        <Textarea
          id="agent-instructions"
          value={draft.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          placeholder={t("agents.instructionsPlaceholder")}
          rows={6}
          className="mt-2 min-h-32"
          data-testid="agent-instructions"
        />
      </section>

      <section className="rounded-xl border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">{t("agents.skills")}</span>
          <Segmented value={draft.skills} options={modes} onChange={(skills) => set({ skills })} testid="agent-skills" />
        </div>
        {draft.skills === "selected" ? (
          <div className="mt-3 space-y-2">
            {selectedSkills.map((k) => (
              <div key={k.id} className="flex items-center gap-2.5 rounded-lg border px-3 py-2" data-testid="agent-skill-row" data-name={k.name}>
                <SkillIcon category={k.category} />
                <span className="min-w-0 flex-1 truncate text-sm">{k.name}</span>
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => set({ skill_ids: draft.skill_ids.filter((id) => id !== k.id) })} aria-label={t("agents.remove", { name: k.name })}>
                  <XIcon />
                </Button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setPicking(true)}
              className="flex w-full flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-4 text-center text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
              data-testid="agent-skills-add"
            >
              <PlusIcon className="size-4" />
              <span className="text-sm text-foreground">{t("agents.skillsAdd")}</span>
              <span className="text-xs">{t("agents.skillsAddHint")}</span>
            </button>
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">{draft.skills === "all" ? t("agents.skillsAllHint", { count: skills.length }) : t("agents.skillsOffHint")}</p>
        )}
      </section>

      <ChainSection deviceId={deviceId} selfId={draft.id} value={draft.chain ?? []} onChange={(chain) => set({ chain })} />

      <div className="flex items-center gap-2 pb-2">
        {saved ? (
          <Button type="button" variant="outline" size="icon-lg" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)} disabled={busy} aria-label={t("agents.delete")} data-testid="agent-delete">
            <Trash2Icon />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          onClick={() => {
            const copy = duplicateAgent(draft, t("agents.copySuffix"));
            const options = readOptions(texts) ?? draft.options;
            if (options) copy.options = options;
            else delete copy.options;
            onDuplicate(copy);
            toast.success(t("agents.duplicated"));
          }}
          disabled={busy || !draft.name.trim()}
          aria-label={t("agents.duplicate")}
          data-testid="agent-duplicate"
        >
          <CopyPlusIcon />
        </Button>
        <Button type="submit" size="lg" className="flex-1" disabled={busy} data-testid="agent-save">
          {busy ? <Loader2Icon className="animate-spin" /> : null}
          {t("common.save")}
        </Button>
      </div>

      <Dialog open={expand} onOpenChange={setExpand}>
        <DialogContent className="sm:max-w-3xl" data-testid="agent-instructions-dialog">
          <DialogHeader>
            <DialogTitle>{t("agents.instructions")}</DialogTitle>
          </DialogHeader>
          <Textarea value={draft.instructions} onChange={(e) => set({ instructions: e.target.value })} placeholder={t("agents.instructionsPlaceholder")} className="h-[60vh] resize-none" />
          <DialogFooter>
            <Button type="button" onClick={() => setExpand(false)}>
              {t("common.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SkillPickerDialog open={picking} onOpenChange={setPicking} skills={skills} selected={draft.skill_ids} onChange={(skill_ids) => set({ skill_ids })} />
      <ConfirmDelete
        open={confirmDelete}
        title={t("agents.deleteTitle", { name: draft.name.trim() || initial.name })}
        description={t("agents.deleteDescription")}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />
    </form>
  );
}

function readOptions(texts: OptionTexts): AgentInput["options"] | undefined {
  const read = readOptionFields(texts);
  return "options" in read && Object.keys(read.options).length > 0 ? read.options : undefined;
}
