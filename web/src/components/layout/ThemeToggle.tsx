// Light/dark switch for the signed-out screens (signed in, the theme lives in Settings → General).

import { MoonIcon, SunIcon } from "lucide-react";
import { useResolvedTheme } from "@/app/theme";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { settingsStore } from "@/stores/settings";

export function ThemeToggle() {
  const resolved = useResolvedTheme();
  const { t } = useT();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={resolved === "dark" ? t("theme.switchToLight") : t("theme.switchToDark")}
      onClick={() => void settingsStore.getState().update({ theme: resolved === "dark" ? "light" : "dark" })}
      data-testid="theme-toggle"
    >
      {resolved === "dark" ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}
