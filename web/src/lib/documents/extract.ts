// Entry point used by the composer. Each kind's library is loaded with a dynamic import only when
// such a file is attached, so pdf.js / mammoth / SheetJS stay out of the main bundle.

import { prepareImage } from "../images";
import { documentKindOf, MAX_DOCUMENT_BYTES } from "./kinds";
import { DocumentError, type ExtractedDocument } from "./types";

/** Embedded docx images go through the same downscale/re-encode as attached photos. */
async function prepareEmbedded(base64: string, mime: string): Promise<string> {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return (await prepareImage(new Blob([bytes], { type: mime }))).base64;
}

export async function extractDocument(file: File): Promise<ExtractedDocument> {
  const kind = documentKindOf(file);
  if (!kind) throw new DocumentError("E_UNSUPPORTED", "not a supported document");
  if (file.size > MAX_DOCUMENT_BYTES) throw new DocumentError("E_TOO_LARGE", "document exceeds 50 MB");
  const bytes = new Uint8Array(await file.arrayBuffer());
  switch (kind) {
    case "pdf": {
      const { extractPdfInBrowser } = await import("./pdf-browser");
      return extractPdfInBrowser(bytes, file.name);
    }
    case "docx": {
      const [{ extractDocx }, mammoth] = await Promise.all([import("./docx"), import("mammoth")]);
      return extractDocx(bytes, file.name, { mammoth: (mammoth.default ?? mammoth) as never, prepare: prepareEmbedded });
    }
    case "sheet": {
      const [{ extractSheet }, XLSX] = await Promise.all([import("./sheet"), import("xlsx")]);
      return extractSheet(bytes, file.name, XLSX);
    }
    case "text": {
      const { extractText } = await import("./text");
      return extractText(bytes, file.name);
    }
  }
}
