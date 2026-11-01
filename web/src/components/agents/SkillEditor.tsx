// One skill's form (SPEC §9.4): name, category (with its coloured icon), a description of when
// it applies, the instructions in markdown; undo, save, delete.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ChevronDownIcon, Loader2Icon, ScrollTextIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n";
import type { Skill, SkillInput } from "@/protocol/channel";
import { LIMITS, SKILL_CATEGORIES } from "@/protocol/constants";
import { libraryStore } from "@/stores/library";
import { useLibrary } from "@/stores/react";
import { errorMessage } from "@/stores/util";
import { SkillIcon } from "./AgentAvatar";
import { ConfirmDelete } from "./library-screen";

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

export interface SkillEditorProps {
  deviceId: string;
  initial: SkillInput;
  saved: boolean;
  onSaved(skill: Skill): void;
  onDeleted(): void;
  onDirtyChange(dirty: boolean): void;
}

export function SkillEditor({ deviceId, initial, saved, onSaved, onDeleted, onDirtyChange }: SkillEditorProps) {
  const { t } = useT();
  const count = useLibrary((s) => s.byDevice[deviceId]?.skills.length ?? 0);
  const [draft, setDraft] = useState<SkillInput>(initial);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const baseline = useMemo(() => JSON.stringify(initial), [initial]);
  const changed = JSON.stringify(draft) !== baseline;
  const dirty = changed || (!saved && draft.name.trim() !== "");
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const set = (patch: Partial<SkillInput>) => setDraft((d) => ({ ...d, ...patch }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const name = draft.name.trim();
    if (!name) return void toast.error(t("skills.nameRequired"));
    if (!draft.description.trim()) return void toast.error(t("skills.descriptionRequired"));
    if (utf8Len(draft.instructions) > LIMITS.INSTRUCTIONS_MAX_BYTES) return void toast.error(t("agents.instructionsTooLong"));
    if (!saved && count >= LIMITS.MAX_SKILLS) return void toast.error(t("skills.limit", { max: LIMITS.MAX_SKILLS }));
    setBusy(true);
    try {
      const skill = await libraryStore.getState().saveSkill(deviceId, { ...draft, name });
      toast.success(t("skills.saved"));
      onSaved(skill);
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
      await libraryStore.getState().deleteSkill(deviceId, draft.id);
      toast.success(t("skills.deleted"));
      onDeleted();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} className="space-y-4" data-testid="skill-editor" data-saved={saved ? "true" : "false"}>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="skill-name">
            {t("skills.name")} <span className="text-destructive">*</span>
          </Label>
          <Input id="skill-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder={t("skills.namePlaceholder")} maxLength={LIMITS.NAME_MAX_CHARS} className="h-9 text-base font-medium" data-testid="skill-name" />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" className="h-9 max-w-[45%] gap-1.5" data-testid="skill-category" data-category={draft.category}>
              {draft.category ? <SkillIcon category={draft.category} /> : <ScrollTextIcon className="size-4 text-muted-foreground" />}
              <span className="truncate">{draft.category ? t(`skills.cat.${draft.category}`) : t("skills.category")}</span>
              <ChevronDownIcon className="size-3.5 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {SKILL_CATEGORIES.map((c) => (
              <DropdownMenuItem key={c} onSelect={() => set({ category: c })} data-testid={`skill-category-${c}`}>
                <SkillIcon category={c} />
                {t(`skills.cat.${c}`)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => set({ category: "" })}>{t("skills.noCategory")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {saved ? (
          <Button type="button" variant="outline" size="icon-lg" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)} disabled={busy} aria-label={t("skills.delete")} data-testid="skill-delete">
            <Trash2Icon />
          </Button>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="skill-description">
          {t("skills.description")} <span className="text-destructive">*</span>
        </Label>
        <Textarea id="skill-description" value={draft.description} onChange={(e) => set({ description: e.target.value })} rows={2} maxLength={LIMITS.SKILL_DESCRIPTION_MAX_CHARS} className="min-h-16" data-testid="skill-description" />
        <p className="text-xs text-muted-foreground">{t("skills.descriptionHint")}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="skill-instructions">{t("skills.instructions")}</Label>
        <Textarea
          id="skill-instructions"
          value={draft.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          placeholder={t("skills.instructionsPlaceholder")}
          rows={12}
          className="min-h-56 font-mono text-[13px] leading-relaxed"
          data-testid="skill-instructions"
        />
      </div>

      <div className="flex justify-end gap-2 pb-2">
        <Button type="button" variant="outline" size="lg" onClick={() => setDraft(initial)} disabled={busy || !changed} data-testid="skill-reset">
          {t("skills.reset")}
        </Button>
        <Button type="submit" size="lg" disabled={busy || (saved && !changed)} data-testid="skill-save">
          {busy ? <Loader2Icon className="animate-spin" /> : null}
          {t("common.save")}
        </Button>
      </div>
      <ConfirmDelete
        open={confirmDelete}
        title={t("skills.deleteTitle", { name: initial.name })}
        description={t("skills.deleteDescription")}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />
    </form>
  );
}
