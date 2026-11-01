// Thinking on/off (the brain), shown left of the model menu only for models that advertise
// `thinking`; the setting is global, the request only carries it for those models.

import { BrainIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/i18n";

export function ThinkToggle({ think, disabled, onChange }: { think: boolean; disabled?: boolean; onChange(v: boolean): void }) {
  const { t } = useT();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={think ? "secondary" : "ghost"}
          size="icon"
          className={cn("rounded-lg [&_svg]:size-[18px]", !think && "text-muted-foreground hover:text-foreground")}
          aria-pressed={think}
          aria-label={t("chat.think")}
          onClick={() => onChange(!think)}
          disabled={disabled}
          data-testid="think-toggle"
        >
          <BrainIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t("chat.thinkHint")}</TooltipContent>
    </Tooltip>
  );
}
