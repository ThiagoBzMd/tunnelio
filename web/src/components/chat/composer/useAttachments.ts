// Photo attachments for vision models: add (button, paste, drop), remove, the per-message limit
// guarded synchronously across concurrent adds, and the client-side preparation (decode →
// ≤ 1568 px → JPEG/PNG, `lib/images`).

import { useRef, useState } from "react";
import { toast } from "sonner";
import { localeOf, useT } from "@/i18n";
import { formatBytes } from "@/lib/format";
import { ImageError, prepareImage, type PreparedImage } from "@/lib/images";
import { LIMITS } from "@/protocol/constants";

/**
 * Image affordance: `hidden` when the device cannot forward images (no "images" capability),
 * `checking` until show_model answered, `disabled` when the model has no vision, else `enabled`.
 */
export type ImageSupport = "hidden" | "checking" | "disabled" | "enabled";

export interface Attachment extends PreparedImage {
  id: string;
  name: string;
}

let attachmentSeq = 0;

export function useAttachments(images: ImageSupport) {
  const { t, lang } = useT();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** Images still being prepared (placeholder tiles). */
  const [pending, setPending] = useState(0);
  /** Slots taken (attached + being prepared): guards the count synchronously across concurrent adds. */
  const slots = useRef(0);

  const addImages = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    if (images !== "enabled") {
      toast.error(t("chat.imagesUnsupported"));
      return;
    }
    const room = LIMITS.MAX_IMAGES_PER_MESSAGE - slots.current;
    if (files.length > room) toast.error(t("chat.tooManyImages", { n: LIMITS.MAX_IMAGES_PER_MESSAGE }));
    const accepted = files.slice(0, Math.max(0, room));
    if (accepted.length === 0) return;
    slots.current += accepted.length;
    setPending((n) => n + accepted.length);
    await Promise.all(
      accepted.map(async (file) => {
        try {
          const prepared = await prepareImage(file);
          setAttachments((cur) => [...cur, { ...prepared, id: `att-${++attachmentSeq}`, name: file.name || "image" }]);
        } catch (e) {
          slots.current -= 1;
          const name = file.name || "image";
          if (e instanceof ImageError && e.code === "E_TOO_LARGE") {
            toast.error(t("chat.imageTooLarge", { name, max: formatBytes(LIMITS.MAX_IMAGE_BYTES, localeOf(lang)) }));
          } else {
            toast.error(t("chat.imageFailed", { name }));
          }
        } finally {
          setPending((n) => n - 1);
        }
      }),
    );
  };

  const removeAttachment = (id: string): void => {
    setAttachments((cur) => {
      if (!cur.some((a) => a.id === id)) return cur;
      slots.current -= 1;
      return cur.filter((a) => a.id !== id);
    });
  };

  /** After a successful send: every slot is free again. */
  const clear = (): void => {
    setAttachments([]);
    slots.current = 0;
  };

  return { attachments, pending, addImages, removeAttachment, clear };
}
