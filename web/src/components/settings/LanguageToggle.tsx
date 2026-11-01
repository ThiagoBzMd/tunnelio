// Compact EN / PT-BR switch (header of the anonymous screens; Settings has the full select).

import { LanguagesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { LANGUAGES, useT, type Language } from "@/i18n";
import { settingsStore } from "@/stores/settings";

const LABELS: Record<Language, string> = { en: "English", "pt-BR": "Português (BR)" };

export function LanguageToggle() {
  const { t, lang } = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t("settings.language")} data-testid="language-toggle">
          <LanguagesIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LANGUAGES.map((l) => (
          <DropdownMenuItem key={l} onSelect={() => void settingsStore.getState().update({ language: l })} data-testid={`language-${l}`} className={l === lang ? "font-medium" : ""}>
            {LABELS[l]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { LABELS as LANGUAGE_LABELS };
