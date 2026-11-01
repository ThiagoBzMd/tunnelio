// The sliders button next to "+" in the composer box: "Agents" picks the chat's agent, "Skills"
// turns skills on for this chat. The chips beside it show what is on and take it off. Agents and
// skills live on the chat's computer (SPEC §9.4).

import { Link } from "react-router";
import { BotIcon, CheckIcon, ScrollTextIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";
import { cn } from "cn";
import { AgentAvatar, SkillIcon } from "@/components/agents/AgentAvatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/i18n";
import { agentSkills } from "@/lib/agents";
import { useWide } from "@/lib/useWide";
import { useDevices } from "@/stores/react";
import type { ChatAgent } from "./useChatAgent";

export function ToolsMenu({ deviceId, chat, disabled }: { deviceId: string | null; chat: ChatAgent; disabled: boolean }) {
  const { t } = useT();
  // A phone has no room for a submenu beside the menu: the lists show in the menu itself.
  const wide = useWide();
  const deviceName = useDevices((s) => (deviceId ? s.devices[deviceId]?.name : undefined)) ?? "";
  const { library, setup, setSetup, agent, chatSkillIds } = chat;
  const fromAgent = new Set(agentSkills(agent, library.skills).map((k) => k.id));
  const active = Boolean(agent) || chatSkillIds.length > 0;
  const toggleSkill = (id: string, on: boolean) => {
    const rest = setup.skillIds.filter((x) => x !== id);
    setSetup({ ...setup, skillIds: on ? [...rest, id] : rest });
  };

  const agentItems = (
    <>
      {library.agents.length === 0 ? <DropdownMenuItem disabled>{library.loading ? t("common.loading") : t("agents.noneYet")}</DropdownMenuItem> : null}
      {library.agents.map((a) => (
        <DropdownMenuItem key={a.id} onSelect={() => setSetup({ ...setup, agentId: a.id })} data-testid="agent-option" data-name={a.name}>
          <AgentAvatar icon={a.icon} />
          <span className="min-w-0 flex-1 truncate">{a.name}</span>
          {a.id === agent?.id ? <CheckIcon className="size-4" /> : null}
        </DropdownMenuItem>
      ))}
      {agent ? (
        <DropdownMenuItem onSelect={() => setSetup({ ...setup, agentId: null })} data-testid="agent-option-none">
          <XIcon />
          {t("agents.noAgent")}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem asChild>
        <Link to="/agents" className="text-muted-foreground" data-testid="tools-manage-agents">
          {t("agents.manage")}
        </Link>
      </DropdownMenuItem>
    </>
  );
  const skillItems = (
    <>
      {library.skills.length === 0 ? <DropdownMenuItem disabled>{library.loading ? t("common.loading") : t("skills.noneYet")}</DropdownMenuItem> : null}
      {library.skills.map((k) => {
        const viaAgent = fromAgent.has(k.id);
        return (
          <DropdownMenuCheckboxItem
            key={k.id}
            checked={viaAgent || setup.skillIds.includes(k.id)}
            disabled={viaAgent}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) => toggleSkill(k.id, on === true)}
            className="gap-2.5 rounded-lg py-2 pl-2.5"
            data-testid="skill-option"
            data-name={k.name}
          >
            <SkillIcon category={k.category} />
            <span className="min-w-0 flex-1 truncate">{k.name}</span>
            {viaAgent ? <span className="shrink-0 text-[11px] text-muted-foreground">{t("agents.byAgent")}</span> : null}
          </DropdownMenuCheckboxItem>
        );
      })}
      <DropdownMenuItem asChild>
        <Link to="/skills" className="text-muted-foreground" data-testid="tools-manage-skills">
          {t("skills.manage")}
        </Link>
      </DropdownMenuItem>
    </>
  );

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("rounded-lg text-muted-foreground hover:text-foreground [&_svg]:size-5", active && "text-foreground")}
              aria-label={t("agents.tools")}
              disabled={disabled || !deviceId}
              data-testid="tools-menu"
              data-active={active ? "true" : "false"}
            >
              <SlidersHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("agents.tools")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" side="top" className={cn("w-64", !wide && "max-h-[60vh] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto")}>
        {library.supported === false ? (
          <DropdownMenuItem disabled className="whitespace-normal" data-testid="tools-unsupported">
            {t("agents.updateApp", { device: deviceName })}
          </DropdownMenuItem>
        ) : wide ? (
          <>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="tools-agents">
                <BotIcon />
                <span className="min-w-0 flex-1 truncate">{t("nav.agents")}</span>
                {agent ? <span className="max-w-24 truncate text-xs text-muted-foreground">{agent.name}</span> : null}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-[60vh] w-64 overflow-y-auto">{agentItems}</DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid="tools-skills">
                <ScrollTextIcon />
                <span className="min-w-0 flex-1 truncate">{t("nav.skills")}</span>
                {chatSkillIds.length > 0 ? <span className="text-xs text-muted-foreground">{chatSkillIds.length}</span> : null}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-[60vh] w-72 overflow-y-auto">{skillItems}</DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        ) : (
          <>
            <DropdownMenuLabel className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="tools-agents">
              <BotIcon className="size-3.5" />
              {t("nav.agents")}
            </DropdownMenuLabel>
            {agentItems}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="tools-skills">
              <ScrollTextIcon className="size-3.5" />
              {t("nav.skills")}
            </DropdownMenuLabel>
            {skillItems}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What is on in this chat, each removable: the agent, and how many skills were turned on. */
export function SetupChips({ chat, disabled }: { chat: ChatAgent; disabled: boolean }) {
  const { t } = useT();
  const { setup, setSetup, agent, chatSkillIds } = chat;
  if (!agent && chatSkillIds.length === 0) return null;
  const chip = "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg border px-2 text-[13px] text-foreground/90";
  return (
    <div className="flex min-w-0 items-center gap-1">
      {agent ? (
        <span className={cn(chip, "max-w-[38vw] md:max-w-56")} data-testid="agent-chip">
          <AgentAvatar icon={agent.icon} className="size-5 border-0 [&_svg]:size-3.5" />
          <span className="truncate">{agent.name}</span>
          <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50" onClick={() => setSetup({ ...setup, agentId: null })} disabled={disabled} aria-label={t("agents.clear")} data-testid="agent-chip-clear">
            <XIcon className="size-3.5" />
          </button>
        </span>
      ) : null}
      {chatSkillIds.length > 0 ? (
        <span className={chip} data-testid="skills-chip">
          <ScrollTextIcon className="size-3.5 text-muted-foreground" />
          <span className="whitespace-nowrap">{t("skills.count", { count: chatSkillIds.length })}</span>
          <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50" onClick={() => setSetup({ ...setup, skillIds: [] })} disabled={disabled} aria-label={t("skills.clear")} data-testid="skills-chip-clear">
            <XIcon className="size-3.5" />
          </button>
        </span>
      ) : null}
    </div>
  );
}
