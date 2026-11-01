// What every extractor returns (SPEC §7.7). DOM-free.

import type { DocumentKind, DocumentMeta } from "./format";

export interface ExtractedDocument {
  name: string;
  kind: DocumentKind;
  /** Extracted text (pdf: every page, with `[Page N]` markers; sheet: CSV per sheet). */
  text: string;
  meta: DocumentMeta;
  /**
   * Candidates to send as images to a model that can see, in order: pdf pages with figures or
   * without text (first pages first), docx embedded images.
   */
  figureCount: number;
  /** pdf only: 1-based pages that draw images. */
  figurePages: number[];
  /** pdf only: 1-based pages without any text (scanned). */
  scannedPages: number[];
  /** pdf with no text on any page: useless to a model that cannot see. */
  scannedOnly: boolean;
  /** Produce up to `limit` candidate images as standard base64 (JPEG/PNG, each ≤ 4 MiB). */
  images(limit: number): Promise<string[]>;
  /** Release what the extractor holds (the parsed PDF). */
  dispose(): void;
}

export type DocumentErrorCode = "E_UNSUPPORTED" | "E_TOO_LARGE" | "E_UNREADABLE" | "E_EMPTY";

export class DocumentError extends Error {
  constructor(
    public readonly code: DocumentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocumentError";
  }
}

/** A document without figures: nothing to render. */
export function textOnly(name: string, kind: DocumentKind, text: string, meta: DocumentMeta): ExtractedDocument {
  return { name, kind, text, meta, figureCount: 0, figurePages: [], scannedPages: [], scannedOnly: false, images: async () => [], dispose: () => undefined };
}
