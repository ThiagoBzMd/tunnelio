// A reply from an agent chain (SPEC §9.4, rev. 1.9): what the agents before the last one answered,
// each in a folded block above the reply, like the thinking. While the chain runs, the block of
// the agent that is answering shows it.

import { useState } from "react";
import { BotIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "cn";
import { useT } from "@/i18n";
import type { ChainStep } from "@/protocol/channel";
import { Markdown } from "./Markdown";

export function ChainSteps({ steps, total, streaming }: { steps: ChainStep[]; total: number; streaming: boolean }) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="chain-steps">
      {steps.map((step, i) => (
        <ChainStepBlock key={`${i}-${step.agent_id}`} step={step} index={i} total={total} answering={streaming && i === steps.length - 1 && steps.length < total} />
      ))}
    </div>
  );
}

function ChainStepBlock({ step, index, total, answering }: { step: ChainStep; index: number; total: number; answering: boolean }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border bg-muted/40 text-sm" data-testid="chain-step" data-answering={answering ? "true" : "false"}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground" aria-expanded={open}>
        <BotIcon className={cn("size-4 shrink-0", answering && "animate-pulse")} />
        <span className="min-w-0 truncate">{t("chat.chainStep", { n: index + 1, total, name: step.name })}</span>
        {answering ? <span className="shrink-0">{t("chat.chainAnswering")}</span> : null}
        <ChevronDownIcon className={cn("ml-auto size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="border-t px-3 py-2 text-muted-foreground" data-testid="chain-step-content">
          {step.content ? <Markdown text={step.content} /> : <span className="italic">{t("chat.emptyReply")}</span>}
          <p className="mt-1 text-xs opacity-80">{step.model}</p>
        </div>
      ) : null}
    </div>
  );
}
