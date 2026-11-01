// The buttons of the box's bottom row: "+" (attach, with the hidden file input), dictation,
// send / stop. Each one is a small component so the composer reads as a layout. The
// send button (a rounded square, like the stop button) only exists once there is something to send.

import { useRef } from "react";
import { ArrowUpIcon, Loader2Icon, MicIcon, MicOffIcon, PlusIcon, SquareIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/i18n";
import { DOCUMENT_ACCEPT } from "@/lib/documents/kinds";
import type { ImageSupport } from "./useAttachments";

/** Opens the file picker (images plus every document kind); `images` tells what the tooltip says. */
export function AttachButton({ images, disabled, onFiles }: { images: ImageSupport; disabled: boolean; onFiles(files: FileList | null): void }) {
  const { t } = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const label = images === "enabled" ? t("chat.attachImage") : t("chat.attachDocuments");
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex" tabIndex={-1}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="rounded-lg text-muted-foreground hover:text-foreground [&_svg]:size-5"
              aria-label={label}
              onClick={() => fileRef.current?.click()}
              disabled={disabled}
              data-testid="attach-image"
              data-images={images}
            >
              <PlusIcon />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <input
        ref={fileRef}
        type="file"
        accept={`image/*,${DOCUMENT_ACCEPT}`}
        multiple
        className="hidden"
        tabIndex={-1}
        data-testid="attach-input"
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );
}

export function DictateButton({ listening, disabled, onToggle }: { listening: boolean; disabled: boolean; onToggle(): void }) {
  const { t } = useT();
  const label = listening ? t("chat.dictateStop") : t("chat.dictate");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={listening ? "secondary" : "ghost"}
          size="icon"
          aria-pressed={listening}
          aria-label={label}
          onClick={onToggle}
          disabled={disabled}
          className={cn("rounded-lg [&_svg]:size-5", listening ? "animate-pulse text-destructive" : "text-muted-foreground hover:text-foreground")}
          data-testid="dictate"
          data-listening={listening ? "true" : "false"}
        >
          {listening ? <MicOffIcon /> : <MicIcon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Stop while a reply streams; otherwise send, rendered only when `visible` (there is text, an
 * attachment or a document) and disabled until the draft can go (spinner while it is prepared).
 */
export function SendOrStop({ streaming, visible, submitting, canSend, onSend, onStop }: { streaming: boolean; visible: boolean; submitting: boolean; canSend: boolean; onSend(): void; onStop(): void }) {
  const { t } = useT();
  if (streaming) {
    return (
      <Button type="button" size="icon" variant="outline" className="rounded-lg" onClick={onStop} aria-label={t("chat.stop")} data-testid="stop">
        <SquareIcon className="size-3 fill-current" />
      </Button>
    );
  }
  if (!visible) return null;
  return (
    <Button type="button" size="icon" className="rounded-lg [&_svg]:size-[18px]" onClick={onSend} disabled={!canSend} aria-label={submitting ? t("chat.preparing") : t("chat.send")} data-testid="send" data-submitting={submitting ? "true" : "false"}>
      {submitting ? <Loader2Icon className="animate-spin" /> : <ArrowUpIcon />}
    </Button>
  );
}
