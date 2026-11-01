// The thread: user/assistant bubbles, streaming cursor, collapsible thinking (and, for a reply from
// an agent chain, the earlier agents' answers, ChainSteps.tsx), stats line, errors.

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircleIcon, BrainIcon, ChevronDownIcon, CopyIcon, CheckIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { localeOf, useT } from "@/i18n";
import { formatDurationNs, tokensPerSecond } from "@/lib/format";
import { parseContent } from "@/lib/documents/format";
import { base64ToBlob, imageDataUrl } from "@/lib/images";
import type { ChatMessage } from "@/stores/chat";
import { ChainSteps } from "./ChainSteps";
import { DocumentChip } from "./DocumentChip";
import { Markdown } from "./Markdown";

export function MessageList({ messages, streaming }: { messages: ChatMessage[]; streaming: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow the stream only while the user is near the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const last = messages[messages.length - 1];
  const lastLen = last?.content.length ?? 0;
  const lastThinkLen = last?.thinking?.length ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastLen, lastThinkLen, streaming]);

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" data-testid="message-list">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
        {messages
          .filter((m) => m.role !== "system")
          .map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
      </div>
    </div>
  );
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") return <UserBubble content={message.content} images={message.images ?? []} />;
  return <AssistantBubble message={message} />;
}

function UserBubble({ content, images }: { content: string; images: string[] }) {
  // Document blocks (SPEC §7.7) become chips, also for messages reloaded from the computer.
  const { documents, prompt } = useMemo(() => parseContent(content), [content]);
  return (
    <div className="flex flex-col items-end gap-1.5" data-testid="message-user" data-documents={documents.length}>
      {documents.map((d, i) => (
        <DocumentChip key={i} doc={d} />
      ))}
      {images.length > 0 ? (
        <div className={cn("grid max-w-[85%] gap-1.5", images.length > 1 ? "grid-cols-2" : "grid-cols-1")} data-testid="message-images">
          {images.map((b64, i) => (
            <UserImage key={i} base64={b64} index={i} />
          ))}
        </div>
      ) : null}
      {prompt ? (
        <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-base leading-relaxed whitespace-pre-wrap text-foreground" data-testid="message-user-text">
          {prompt}
        </div>
      ) : null}
    </div>
  );
}

function AssistantBubble({ message }: { message: ChatMessage }) {
  const { t, lang } = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const tps = tokensPerSecond(message.stats);
  return (
    <div className="group/msg flex flex-col gap-1.5" data-testid="message-assistant" data-streaming={message.streaming ? "true" : "false"}>
      {message.chain && message.chain.length > 0 ? <ChainSteps steps={message.chain} total={message.chainTotal ?? message.chain.length + 1} streaming={Boolean(message.streaming)} /> : null}
      {message.thinking ? <Thinking text={message.thinking} streaming={Boolean(message.streaming) && !message.content} /> : null}
      {/* Replies read in the serif, like a page; code stays monospace (index.css). */}
      <div className="min-w-0 font-serif text-[16.5px] leading-[1.7]">
        {message.content ? <Markdown text={message.content} /> : null}
        {message.streaming ? <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse bg-foreground align-baseline" aria-label={t("chat.generating")} /> : null}
        {!message.content && !message.streaming && !message.error ? <p className="text-muted-foreground italic">{t("chat.emptyReply")}</p> : null}
      </div>
      {message.error ? (
        <p className="flex items-center gap-1.5 text-sm text-destructive" data-testid="message-error">
          <AlertCircleIcon className="size-4" />
          {message.error}
        </p>
      ) : null}
      {message.aborted ? <p className="text-xs text-muted-foreground">{t("chat.aborted")}</p> : null}
      {!message.streaming ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Button variant="ghost" size="icon-xs" onClick={copy} aria-label={t("common.copy")} className="opacity-60 hover:opacity-100">
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
          {message.model ? <span className="truncate">{message.model}</span> : null}
          {message.stats?.eval_count !== undefined ? (
            <span data-testid="message-stats">
              {t("chat.stats", {
                tokens: message.stats.eval_count,
                tps: tps ? tps.toLocaleString(localeOf(lang), { maximumFractionDigits: 0 }) : "–",
                time: formatDurationNs(message.stats.total_duration, localeOf(lang)),
              })}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Thumbnail (≤ 240 px) that opens the full-size image in a new tab through a blob URL. */
function UserImage({ base64, index }: { base64: string; index: number }) {
  const { t } = useT();
  const src = useMemo(() => imageDataUrl(base64), [base64]);
  const open = () => {
    let url: string;
    try {
      url = URL.createObjectURL(base64ToBlob(base64));
    } catch {
      return;
    }
    window.open(url, "_blank", "noopener");
    // The new tab has fetched the blob long before this; revoking too early breaks slow tabs.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  return (
    <button
      type="button"
      onClick={open}
      aria-label={t("chat.openImage")}
      className="overflow-hidden rounded-xl border bg-muted/30 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <img src={src} alt={t("chat.attachedImage", { n: index + 1 })} className="block max-h-60 max-w-60 object-cover" loading="lazy" decoding="async" data-testid="message-image" />
    </button>
  );
}

function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border bg-muted/40 text-sm" data-testid="thinking">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground" aria-expanded={open}>
        <BrainIcon className={cn("size-4", streaming && "animate-pulse")} />
        <span>{streaming ? t("chat.thinking") : t("chat.thoughts")}</span>
        <ChevronDownIcon className={cn("ml-auto size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open ? <div className="border-t px-3 py-2 whitespace-pre-wrap text-muted-foreground">{text}</div> : null}
    </div>
  );
}
