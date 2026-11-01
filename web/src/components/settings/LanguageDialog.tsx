// "Choose your language": a search box and the options (automatic = the browser's language).
// Opened from the account menu and from Settings → General.

import { useState } from "react";
import { CheckIcon, SearchIcon } from "lucide-react";
import { cn } from "cn";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT, type Language } from "@/i18n";
import { matchesQuery } from "@/lib/text";
import { useSettings, useUi } from "@/stores/react";
import { settingsStore } from "@/stores/settings";
import { uiStore } from "@/stores/ui";

/** Native name and its English name, like the reference app lists them. */
export const LANGUAGE_NAMES: Record<Language, { native: string; english: string }> = {
  en: { native: "English (United States)", english: "English (United States)" },
  "pt-BR": { native: "Português (Brasil)", english: "Portuguese (Brazil)" },
};

type Option = { value: Language | "auto"; native: string; sub: string };

export function LanguageDialog() {
  const { t } = useT();
  const open = useUi((s) => s.language);
  const current = useSettings((s) => s.settings.language);
  const [query, setQuery] = useState("");
  const options: Option[] = [
    { value: "auto", native: t("language.autoName"), sub: t("language.autoHint") },
    ...(Object.keys(LANGUAGE_NAMES) as Language[]).map((l) => ({ value: l, native: LANGUAGE_NAMES[l].native, sub: LANGUAGE_NAMES[l].english })),
  ];
  const shown = options.filter((o) => matchesQuery(`${o.native} ${o.sub}`, query));
  const close = () => {
    uiStore.getState().setLanguage(false);
    setQuery("");
  };
  const choose = (v: Option["value"]) => {
    void settingsStore.getState().update({ language: v === "auto" ? null : v });
    close();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? uiStore.getState().setLanguage(true) : close())}>
      <DialogContent className="gap-5 p-6 sm:max-w-3xl" data-testid="language-dialog">
        <DialogHeader>
          <DialogTitle className="text-2xl font-semibold tracking-tight">{t("language.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("language.title")}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("language.search")}
            className="h-11 w-full rounded-xl border bg-transparent pr-3 pl-10 text-[15px] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
            data-testid="language-search"
          />
        </div>
        {shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("language.none")}</p>
        ) : (
          <div className="grid gap-1 sm:grid-cols-3">
            {shown.map((o) => {
              const selected = (current ?? "auto") === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => choose(o.value)}
                  className={cn("flex items-start gap-2 rounded-xl px-3.5 py-3 text-left transition-colors hover:bg-accent", selected && "bg-accent")}
                  aria-pressed={selected}
                  data-testid={`language-option-${o.value}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{o.native}</span>
                    <span className="block truncate text-[13px] text-muted-foreground">{o.sub}</span>
                  </span>
                  {selected ? <CheckIcon className="mt-0.5 size-4 shrink-0" /> : null}
                </button>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
