// From what the user attached to what one `chat` user message carries (SPEC §7.7): document blocks
// before the prompt; for a model that can see, pdf pages with figures / without text and docx
// images go as images together with the photos, within the per-message limit (photos first,
// then documents in order, first pages first). DOM-free (rendering is behind `images()`).

import { composeContent, type DocumentBlock } from "./format";
import type { ExtractedDocument } from "./types";

export interface ComposeOptions {
  /** The selected model can see images (`vision`). */
  vision: boolean;
  /** Images per message (SPEC §0.3, also the device's limit). */
  maxImages: number;
}

export interface ComposedMessage {
  content: string;
  images: string[];
  blocks: DocumentBlock[];
}

export async function composeMessage(prompt: string, photos: string[], documents: ExtractedDocument[], opts: ComposeOptions): Promise<ComposedMessage> {
  const images = [...photos];
  let room = Math.max(0, opts.maxImages - photos.length);
  const blocks: DocumentBlock[] = [];
  for (const d of documents) {
    let sent = 0;
    if (opts.vision && d.figureCount > 0 && room > 0) {
      const rendered = await d.images(Math.min(room, d.figureCount));
      images.push(...rendered);
      room -= rendered.length;
      sent = rendered.length;
    }
    const skipped = d.figureCount - sent;
    blocks.push({ name: d.name, kind: d.kind, text: d.text, meta: { ...d.meta, ...(skipped > 0 ? { skipped_figures: skipped } : {}) } });
  }
  return { content: composeContent(blocks, prompt.trim()), images, blocks };
}

/** Upper bound of the characters a draft adds to the conversation (blocks + prompt), without rendering. */
export function draftChars(prompt: string, documents: ExtractedDocument[]): number {
  const blocks: DocumentBlock[] = documents.map((d) => ({ name: d.name, kind: d.kind, text: d.text, meta: d.meta }));
  return composeContent(blocks, prompt.trim()).length;
}

export type DraftIssue = "scanned_block" | "figures_warn" | "scanned_warn";

/**
 * What to tell the user before sending documents to a model that cannot see (`vision === false`):
 * a PDF with no text at all blocks the send; figures or some scanned pages only warn. Unknown
 * vision (`null`, still checking) → nothing.
 */
export function draftIssues(documents: ExtractedDocument[], vision: boolean | null): { block: DraftIssue | null; warnings: DraftIssue[] } {
  if (vision !== false) return { block: null, warnings: [] };
  const block = documents.some((d) => d.scannedOnly) ? "scanned_block" : null;
  const warnings: DraftIssue[] = [];
  if (documents.some((d) => d.figurePages.length > 0 || (d.kind === "docx" && d.figureCount > 0))) warnings.push("figures_warn");
  if (documents.some((d) => !d.scannedOnly && d.scannedPages.length > 0)) warnings.push("scanned_warn");
  return { block, warnings };
}
