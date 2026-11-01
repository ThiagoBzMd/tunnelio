// What a new chat shows above the composer: the greeting ("Good evening, Name" next to the mark,
// or the anonymous-mode title), and the ghost that starts an anonymous chat.

import { GhostIcon } from "lucide-react";
import { cn } from "cn";
import { AgentAvatar } from "@/components/agents/AgentAvatar";
import { Logo } from "@/components/layout/Logo";
import { phoneRoundButton } from "@/components/layout/phone";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT, type TKey } from "@/i18n";
import { timeOfDay, type TimeOfDay } from "@/lib/greeting";
import { useDisplayName } from "@/lib/useDisplayName";

const GREETING: Record<TimeOfDay, TKey> = { morning: "chat.goodMorning", afternoon: "chat.goodAfternoon", evening: "chat.goodEvening" };

/**
 * Phone: the mark above the greeting, both in the middle of the screen, the composer at the
 * bottom. Desktop: the mark beside the greeting, greeting and composer together in the middle
 * (the parent centres them).
 */
export function Greeting({ incognito, hint }: { incognito: boolean; hint: string | null }) {
  const { t } = useT();
  const name = useDisplayName();
  const greeting = t(GREETING[timeOfDay(new Date().getHours())]);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-6 pb-[4vh] text-center md:flex-none md:justify-start md:overflow-visible md:pt-0 md:pb-8"
      data-testid="chat-empty"
      data-incognito={incognito ? "true" : "false"}
    >
      <div className="flex flex-col items-center gap-4 md:flex-row md:gap-3.5">
        <Logo variant="mark" className="size-9 shrink-0 md:size-10" />
        <h2 className="font-serif text-[28px] leading-tight font-normal tracking-[-0.01em] text-balance md:text-[40px]" data-testid={incognito ? "chat-incognito" : "chat-greeting"}>
          {incognito ? t("chat.incognitoOn") : name ? `${greeting}, ${name}` : greeting}
        </h2>
      </div>
      {hint ? <p className="max-w-sm text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** A new chat with an agent: its icon, name and description instead of the greeting. */
export function AgentIntro({ icon, name, description, hint }: { icon: string; name: string; description: string; hint: string | null }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-6 pb-[4vh] text-center md:flex-none md:justify-start md:overflow-visible md:pt-0 md:pb-8" data-testid="chat-empty" data-agent="true">
      <AgentAvatar icon={icon} size="lg" />
      <h2 className="font-serif text-[30px] leading-tight font-normal tracking-[-0.01em] text-balance md:text-[36px]" data-testid="agent-intro-name">
        {name}
      </h2>
      {description ? (
        <p className="max-w-md text-[15px] whitespace-pre-line text-muted-foreground" data-testid="agent-intro-description">
          {description}
        </p>
      ) : null}
      {hint ? <p className="max-w-sm text-sm text-destructive">{hint}</p> : null}
    </div>
  );
}

/** The ghost at the top right of a new chat; disabled (with the reason) when the computer's app is too old. */
export function IncognitoButton({ supported, onStart }: { supported: boolean; onStart(): void }) {
  const { t } = useT();
  const label = supported ? t("chat.incognitoStart") : t("chat.incognitoUnsupported");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={-1}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("size-9 text-muted-foreground hover:text-foreground [&_svg]:size-5", phoneRoundButton)}
            aria-label={t("chat.incognito")}
            disabled={!supported}
            onClick={onStart}
            data-testid="incognito-toggle"
          >
            <GhostIcon />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
