// Thumbnails of the photos attached to the draft, each removable, plus a spinner tile per image
// still being prepared. Renders nothing when there is nothing to show.

import { Loader2Icon, XIcon } from "lucide-react";
import { localeOf, useT } from "@/i18n";
import { formatBytes } from "@/lib/format";
import { imageDataUrl } from "@/lib/images";
import type { Attachment } from "./useAttachments";

export function AttachmentStrip({ attachments, pending, onRemove }: { attachments: Attachment[]; pending: number; onRemove(id: string): void }) {
  const { t, lang } = useT();
  if (attachments.length === 0 && pending === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-1 pb-1.5" data-testid="attachments">
      {attachments.map((a, i) => (
        <div key={a.id} className="relative size-16 overflow-hidden rounded-lg border bg-muted/40" data-testid="attachment" data-mime={a.mime}>
          <img src={imageDataUrl(a.base64)} alt={t("chat.attachedImage", { n: i + 1 })} className="size-full object-cover" title={`${a.name} · ${a.width}×${a.height} · ${formatBytes(a.bytes, localeOf(lang))}`} />
          <button
            type="button"
            onClick={() => onRemove(a.id)}
            aria-label={t("chat.removeImage")}
            className="absolute top-0.5 right-0.5 rounded-full border bg-background/95 p-0.5 text-foreground shadow-sm hover:bg-background"
            data-testid="attachment-remove"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
      {Array.from({ length: pending }, (_, i) => (
        <div key={`pending-${i}`} className="flex size-16 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground" data-testid="attachment-pending">
          <Loader2Icon className="size-4 animate-spin" />
        </div>
      ))}
    </div>
  );
}
