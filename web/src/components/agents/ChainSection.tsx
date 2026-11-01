// Advanced → Chain (SPEC §9.4, rev. 1.9): the agents that answer after this one, in order. In a chat,
// this agent answers first; each next one gets the conversation and the previous answer; the last
// one's answer is the reply, the earlier ones stay above it, folded like the thinking. Only on a
// computer whose Tunnelio keeps chains (capability "chain").

import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/i18n";
import { LIMITS } from "@/protocol/constants";
import { useLibrary, useSessions } from "@/stores/react";
import { AgentAvatar } from "./AgentAvatar";

export function ChainSection({ deviceId, selfId, value, onChange }: { deviceId: string; selfId: string; value: string[]; onChange(chain: string[]): void }) {
  const { t } = useT();
  const agents = useLibrary((s) => s.byDevice[deviceId]?.agents) ?? [];
  const supported = useSessions((s) => Boolean(s.sessions[deviceId]?.device_info?.capabilities.includes("chain")));
  const [open, setOpen] = useState(value.length > 0);
  const members = value.map((id) => agents.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  const choices = agents.filter((a) => a.id !== selfId && !value.includes(a.id));
  const move = (from: number, to: number) => {
    const next = members.map((a) => a.id);
    const [id] = next.splice(from, 1);
    if (id) next.splice(to, 0, id);
    onChange(next);
  };

  return (
    <section className="rounded-xl border bg-card" data-testid="agent-advanced">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 p-4 text-left text-sm font-medium" aria-expanded={open} data-testid="agent-advanced-toggle">
        {t("agents.advanced")}
        <ChevronDownIcon className={cn("ml-auto size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="space-y-3 border-t p-4" data-testid="agent-chain">
          <div>
            <p className="text-sm font-medium">{t("agents.chain")}</p>
            <p className="text-xs text-muted-foreground">{supported ? t("agents.chainHint", { max: LIMITS.CHAIN_MAX }) : t("agents.chainUnsupported")}</p>
          </div>
          {members.length > 0 ? (
            <ol className="space-y-2">
              {members.map((a, i) => (
                <li key={a.id} className="flex items-center gap-2.5 rounded-lg border px-3 py-2" data-testid="agent-chain-row" data-name={a.name}>
                  <span className="w-4 shrink-0 text-center text-xs text-muted-foreground">{i + 2}</span>
                  <AgentAvatar icon={a.icon} className="size-6 [&_svg]:size-3.5" />
                  <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
                  <Button type="button" variant="ghost" size="icon-sm" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={t("agents.chainUp", { name: a.name })}>
                    <ArrowUpIcon />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" disabled={i === members.length - 1} onClick={() => move(i, i + 1)} aria-label={t("agents.chainDown", { name: a.name })}>
                    <ArrowDownIcon />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange(members.filter((m) => m.id !== a.id).map((m) => m.id))} aria-label={t("agents.remove", { name: a.name })}>
                    <XIcon />
                  </Button>
                </li>
              ))}
            </ol>
          ) : null}
          {supported && members.length < LIMITS.CHAIN_MAX ? (
            <Select value="" onValueChange={(id) => onChange([...members.map((m) => m.id), id])} disabled={choices.length === 0}>
              <SelectTrigger className="h-9 w-full" data-testid="agent-chain-add">
                <SelectValue placeholder={choices.length > 0 ? t("agents.chainAdd") : members.length > 0 ? t("agents.chainAllIn") : t("agents.chainNoOthers")} />
              </SelectTrigger>
              <SelectContent position="popper">
                {choices.map((a) => (
                  <SelectItem key={a.id} value={a.id} data-testid={`agent-chain-option-${a.name}`}>
                    <AgentAvatar icon={a.icon} className="size-5 border-0 [&_svg]:size-3.5" />
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
