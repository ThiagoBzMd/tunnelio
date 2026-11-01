// Phone: the theme as three preview cards (light, dark, the system's). The desktop keeps the
// sun/moon/monitor switch (ThemePicker.tsx); same setting, same test ids.

import { cn } from "cn";
import { useT, type TKey } from "@/i18n";
import { useSettings } from "@/stores/react";
import { settingsStore, type Settings } from "@/stores/settings";

const OPTIONS: readonly (readonly [Settings["theme"], TKey])[] = [
  ["light", "settings.themeLight"],
  ["dark", "settings.themeDark"],
  ["system", "settings.themeSystem"],
];

// Fixed colours on purpose: each card shows its own theme whatever the current one is.
const FACE: Record<Settings["theme"], string> = {
  light: "bg-white",
  dark: "bg-neutral-900",
  system: "bg-[linear-gradient(135deg,#fff_50%,#171717_50%)]",
};

export function ThemeCards() {
  const { t } = useT();
  const theme = useSettings((s) => s.settings.theme);
  return (
    <div role="radiogroup" aria-label={t("settings.theme")} className="grid grid-cols-3 gap-3 p-4" data-testid="theme-picker">
      {OPTIONS.map(([value, label]) => {
        const on = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => void settingsStore.getState().update({ theme: value })}
            className="flex flex-col items-center gap-2"
            data-testid={`theme-option-${value}`}
          >
            <span className={cn("block w-full rounded-2xl border-2 p-1 transition-colors", on ? "border-foreground" : "border-transparent")}>
              <span className={cn("relative block aspect-[4/3] w-full overflow-hidden rounded-xl border border-black/10", FACE[value])}>
                <span className="absolute top-[22%] left-[14%] h-1 w-[46%] rounded-full bg-neutral-400/80" />
                <span className="absolute top-[36%] left-[14%] h-1 w-[30%] rounded-full bg-neutral-400/80" />
                <span className="absolute right-[12%] bottom-[16%] aspect-square w-[18%] rounded-full bg-neutral-500" />
              </span>
            </span>
            <span className={cn("text-[15px]", on ? "font-medium text-foreground" : "text-muted-foreground")}>{t(label)}</span>
          </button>
        );
      })}
    </div>
  );
}
