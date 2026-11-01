// Message composer: auto-growing textarea, Enter sends, Shift+Enter newline, stop while streaming,
// explicit disabled states (device offline, no model), image attachments for vision models and
// documents for every model (button, paste, drag & drop; read in the browser, SPEC §7.7), live
// warnings/blocks before sending (figures a model cannot see, too long for the model), and
// dictation through the browser's own speech engine. The pieces live in ./composer/. Inside the
// box, the bottom row holds "+" (attach), the microphone and the send button, which only shows up
// once there is something to send. The slots the screen passes in (device picker and model menu,
// where thinking and the per-model settings live) sit in a quiet row under the box.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { PaperclipIcon } from "lucide-react";
import { cn } from "cn";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n";
import { isImageFile } from "@/lib/documents/kinds";
import type { ExtractedDocument } from "@/lib/documents/types";
import { joinWithSpace } from "@/lib/speech";
import { DraftDocumentChip } from "./DocumentChip";
import { AttachmentStrip } from "./composer/AttachmentStrip";
import { ComposerNotices } from "./composer/Notices";
import { AttachButton, DictateButton, SendOrStop } from "./composer/Toolbar";
import { useAttachments, type ImageSupport } from "./composer/useAttachments";
import { useDictation } from "./composer/useDictation";
import { useDocuments } from "./composer/useDocuments";
import { useDraftLimits } from "./composer/useDraftLimits";
import { useFileDrop } from "./composer/useFileDrop";

export type { ImageSupport };

export interface ComposerProps {
  disabled: boolean;
  /** Why the composer is disabled (shown above the box). */
  disabledReason: string | null;
  streaming: boolean;
  stalled: boolean;
  images: ImageSupport;
  /** Show the dictation button (user setting; also requires browser support). */
  dictation: boolean;
  /** The selected model can see images: `null` while that is being checked. */
  vision: boolean | null;
  /** Characters of the conversation so far (the model memory rule, SPEC §7.7). */
  historyChars: number;
  /** `context_length` of the selected model, when known. */
  contextMax: number | null;
  /** Placeholder of the box (the screen varies it between an empty chat and a thread). */
  placeholder?: string | undefined;
  /** Anonymous chat: the box gets a dashed border. */
  dashed?: boolean | undefined;
  /** Rendered in the row under the box: `leading` on the left, `trailing` on the right. */
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Rendered inside the box, right after "+" (the agents and skills menu, and its chips). */
  tools?: ReactNode;
  /**
   * `text` may be empty when there are images or documents. Resolves true once the message was
   * accepted (the composer then clears); false keeps everything for the user to adjust.
   */
  onSend(text: string, images: string[], documents: ExtractedDocument[]): Promise<boolean>;
  onStop(): void;
}

export function Composer({ disabled, disabledReason, streaming, stalled, images, dictation, vision, historyChars, contextMax, placeholder, dashed = false, leading, trailing, tools, onSend, onStop }: ComposerProps) {
  const { t } = useT();
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const focusInput = () => requestAnimationFrame(() => ref.current?.focus());

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const photos = useAttachments(images);
  const docs = useDocuments();
  const voice = useDictation({ append: (chunk) => setText((cur) => joinWithSpace(cur, chunk)), onEnd: focusInput });
  const addFiles = async (list: ArrayLike<File> | null | undefined) => {
    const files = Array.from(list ?? []);
    await Promise.all([photos.addImages(files.filter(isImageFile)), docs.addDocuments(files.filter((f) => !isImageFile(f)))]);
  };
  const drop = useFileDrop({ disabled, onFiles: (files) => void addFiles(files) });

  const { blocked, warnings } = useDraftLimits({ text, readyDocs: docs.readyDocs, vision, historyChars, contextMax });
  const hasContent = text.trim().length > 0 || voice.interim.trim().length > 0 || photos.attachments.length > 0 || docs.readyDocs.length > 0;
  const canSend = !disabled && !streaming && !submitting && photos.pending === 0 && !docs.reading && hasContent && !blocked;

  const send = async () => {
    if (!canSend) return;
    const value = joinWithSpace(text, voice.takeInterim()).trim();
    setSubmitting(true);
    let ok = false;
    try {
      ok = await onSend(value, photos.attachments.map((a) => a.base64), docs.readyDocs);
    } finally {
      setSubmitting(false);
    }
    if (ok) {
      docs.clear();
      photos.clear();
      setText("");
    }
    focusInput();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="shrink-0 bg-background px-3 pb-safe md:px-4" data-testid="composer">
      <div className="mx-auto w-full max-w-3xl pb-2 md:pb-3">
        <ComposerNotices disabledReason={disabledReason} blocked={blocked} warnings={warnings} stalled={stalled} />
        <div
          className={cn(
            "relative flex flex-col rounded-[20px] border bg-card px-4 pt-4 pb-3 shadow-[0_4px_20px_rgba(0,0,0,0.04)] transition-colors focus-within:border-ring/50 dark:shadow-none",
            dashed && "border-dashed border-muted-foreground/40",
            disabled && "opacity-60",
            drop.dragging && "border-ring ring-2 ring-ring/40",
          )}
          {...drop.dropZoneProps}
          data-testid="composer-dropzone"
          data-dragging={drop.dragging ? "true" : "false"}
        >
          {drop.dragging ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[20px] bg-background/85 text-sm font-medium" aria-hidden>
              <PaperclipIcon className="mr-2 size-4" />
              {t("chat.dropImages")}
            </div>
          ) : null}
          {docs.documents.length > 0 ? (
            <div className="flex flex-wrap gap-2 pb-2" data-testid="draft-documents">
              {docs.documents.map((d) => (
                <DraftDocumentChip key={d.id} name={d.name} kind={d.doc?.kind ?? null} meta={d.doc?.meta ?? null} reading={d.doc === null} onRemove={() => docs.removeDocument(d.id)} />
              ))}
            </div>
          ) : null}
          <AttachmentStrip attachments={photos.attachments} pending={photos.pending} onRemove={photos.removeAttachment} />
          <Textarea
            ref={ref}
            rows={1}
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            onPaste={drop.onPaste}
            placeholder={voice.listening && !text ? "…" : (placeholder ?? t("chat.placeholder"))}
            className="max-h-[240px] min-h-[24px] resize-none rounded-none border-0 bg-transparent p-0 text-base leading-6 shadow-none placeholder:text-muted-foreground/80 focus-visible:ring-0 md:text-base dark:bg-transparent"
            data-testid="composer-input"
          />
          {voice.interim ? (
            <p className="text-base leading-relaxed text-muted-foreground italic" data-testid="dictation-interim" aria-live="polite">
              {voice.interim}
            </p>
          ) : null}
          <div className="mt-3 flex items-center gap-1">
            <AttachButton images={images} disabled={disabled} onFiles={(files) => void addFiles(files)} />
            {tools}
            <div className="ml-auto flex items-center gap-1">
              {dictation && voice.supported ? <DictateButton listening={voice.listening} disabled={disabled} onToggle={voice.toggle} /> : null}
              <SendOrStop streaming={streaming} visible={hasContent} submitting={submitting} canSend={canSend} onSend={() => void send()} onStop={onStop} />
            </div>
          </div>
        </div>
        {leading || trailing ? (
          <div className="mt-2 flex items-center justify-between gap-2 px-1" data-testid="composer-pickers">
            <div className="flex min-w-0 items-center">{leading}</div>
            <div className="flex min-w-0 items-center justify-end">{trailing}</div>
          </div>
        ) : null}
        {voice.showHint ? (
          <p className="mt-1.5 text-center text-[11px] text-muted-foreground/70" data-testid="dictation-hint">
            {t("chat.dictationHint")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
