// Small pieces of the agent editor: the icon gallery, the Off / All / Selected switch and the
// window that picks skills (search and category filter).

import { useMemo, useState } from "react";
import { Link } from "react-router";
import { CheckIcon, PlusIcon, SearchIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/i18n";
import { AGENT_ICON_NAMES, AgentGlyph } from "@/lib/agent-icons";
import type { Skill } from "@/protocol/channel";
import { SKILL_CATEGORIES, type SkillCategory } from "@/protocol/constants";
import { SkillIcon } from "./AgentAvatar";

export function IconPicker({ value, onChange }: { value: string; onChange(icon: string): void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative inline-flex size-16 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-border text-foreground/80 transition-colors hover:border-ring hover:bg-accent/50"
        aria-label={t("agents.icon")}
        data-testid="agent-icon-button"
        data-icon={value}
      >
        <AgentGlyph name={value} className="size-7" />
        <span className="absolute -right-0.5 -bottom-0.5 inline-flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground">
          <PlusIcon className="size-3" />
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" data-testid="icon-picker">
          <DialogHeader>
            <DialogTitle>{t("agents.icon")}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8">
            {AGENT_ICON_NAMES.map((name) => {
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    onChange(name);
                    setOpen(false);
                  }}
                  className={cn("inline-flex aspect-square items-center justify-center rounded-lg text-foreground/80 hover:bg-accent", name === value && "bg-accent ring-1 ring-ring")}
                  aria-label={name}
                  aria-pressed={name === value}
                  data-testid={`icon-option-${name}`}
                >
                  <AgentGlyph name={name} className="size-5" />
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A compact segmented switch (Off / All / Selected). */
export function Segmented<T extends string>({ value, options, onChange, testid }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void; testid: string }) {
  return (
    <div className="inline-flex shrink-0 rounded-lg border bg-muted/60 p-0.5" role="radiogroup" data-testid={testid}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn("rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors", o.value === value ? "bg-background text-foreground shadow-sm" : "hover:text-foreground")}
          data-testid={`${testid}-${o.value}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Pick skills for an agent: search by name, filter by category, tick any number. */
export function SkillPickerDialog({ open, onOpenChange, skills, selected, onChange }: { open: boolean; onOpenChange(open: boolean): void; skills: Skill[]; selected: string[]; onChange(ids: string[]): void }) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<SkillCategory | null>(null);
  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return skills.filter((k) => (!category || k.category === category) && (!q || k.name.toLocaleLowerCase().includes(q) || k.description.toLocaleLowerCase().includes(q)));
  }, [skills, query, category]);
  const used = new Set(skills.map((k) => k.category));
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="skill-picker">
        <DialogHeader>
          <DialogTitle>{t("agents.skillsPickTitle")}</DialogTitle>
          <DialogDescription>{t("agents.skillsAddHint")}</DialogDescription>
        </DialogHeader>
        {skills.length === 0 ? (
          <div className="space-y-3 py-2 text-sm text-muted-foreground">
            <p>{t("agents.skillsNone")}</p>
            <Button variant="outline" asChild>
              <Link to="/skills">{t("agents.skillsCreate")}</Link>
            </Button>
          </div>
        ) : (
          <>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("agents.skillsSearch")}
                className="h-9 w-full rounded-lg border bg-transparent pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
                data-testid="skill-picker-search"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <CategoryChip on={category === null} onClick={() => setCategory(null)} label={t("agents.allCategories")} />
              {SKILL_CATEGORIES.filter((c) => used.has(c)).map((c) => (
                <CategoryChip key={c} on={category === c} onClick={() => setCategory(c)} label={t(`skills.cat.${c}`)} category={c} />
              ))}
            </div>
            <ul className="-mx-1 max-h-[45vh] space-y-0.5 overflow-y-auto">
              {shown.map((k) => {
                const on = selected.includes(k.id);
                return (
                  <li key={k.id}>
                    <button type="button" onClick={() => toggle(k.id)} className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-accent" aria-pressed={on} data-testid="skill-picker-option" data-name={k.name}>
                      <SkillIcon category={k.category} className="mt-0.5" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{k.name}</span>
                        {k.description ? <span className="line-clamp-2 text-xs text-muted-foreground">{k.description}</span> : null}
                      </span>
                      <span className={cn("mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded border", on ? "border-primary bg-primary text-primary-foreground" : "border-input")}>{on ? <CheckIcon className="size-3" /> : null}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)} data-testid="skill-picker-done">
            {t("common.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CategoryChip({ on, onClick, label, category }: { on: boolean; onClick(): void; label: string; category?: SkillCategory }) {
  return (
    <button type="button" onClick={onClick} className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs", on ? "border-foreground/30 bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")} aria-pressed={on}>
      {category ? <SkillIcon category={category} className="size-3.5" /> : null}
      {label}
    </button>
  );
}

