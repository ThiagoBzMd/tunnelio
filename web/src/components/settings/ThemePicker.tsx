// Theme: light (sun), dark (moon) or the system's (monitor).

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useT, type TKey } from "@/i18n";
import { useSettings } from "@/stores/react";
import { settingsStore, type Settings } from "@/stores/settings";

const OPTIONS: readonly (readonly [Settings["theme"], typeof SunIcon, TKey])[] = [
  ["light", SunIcon, "settings.themeLight"],
  ["dark", MoonIcon, "settings.themeDark"],
  ["system", MonitorIcon, "settings.themeSystem"],
];

export function ThemePicker() {
  const { t } = useT();
  const theme = useSettings((s) => s.settings.theme);
  return (
    <div role="radiogroup" aria-label={t("settings.theme")} className="inline-flex gap-1 rounded-xl bg-muted p-1" data-testid="theme-picker">
      {OPTIONS.map(([value, Icon, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          onClick={() => void settingsStore.getState().update({ theme: value })}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:text-foreground aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm"
          data-testid={`theme-option-${value}`}
        >
          <Icon className="size-4" />
          {t(label)}
        </button>
      ))}
    </div>
  );
}
