// PDF through pdf.js: text of every page (`getTextContent`), pages that draw images detected from
// the operator list (paintImageXObject / paintInlineImageXObject / paintImageMaskXObject), pages
// without any text counted as scanned. Pages are rendered to images only when they will be sent
// (see `images`). The pdf.js module and the page renderer are injected: the browser passes the
// worker-backed build and a canvas renderer (pdf-browser.ts); tests pass the Node build.

import type * as PdfjsNS from "pdfjs-dist/legacy/build/pdf.mjs";
import { DocumentError, type ExtractedDocument } from "./types";

export type Pdfjs = typeof PdfjsNS;
export type PdfPage = Awaited<ReturnType<Awaited<ReturnType<Pdfjs["getDocument"]>["promise"]>["getPage"]>>;

export interface PdfDeps {
  pdfjs: Pdfjs;
  /** Page → standard base64 JPEG (≤ 4 MiB). Without it no page images are produced. */
  renderPage?: (page: PdfPage) => Promise<string>;
}

/**
 * pdf.js 5+ relies on `Promise.withResolvers` and `ArrayBuffer.prototype.transferToFixedLength`,
 * which Safari < 17.4 and Node 20 lack, and iterates `ReadableStream`s with `for await`
 * (`getTextContent`), which Safari (iOS included) lacks. Minimal stand-ins (the buffer one copies
 * instead of detaching, which is all pdf.js needs).
 */
export function ensurePdfjsPolyfills(): void {
  if (typeof ReadableStream !== "undefined") {
    const RS = ReadableStream.prototype as unknown as Record<PropertyKey, unknown>;
    if (typeof RS[Symbol.asyncIterator] !== "function") {
      const values = async function* values(this: ReadableStream<unknown>, opts?: { preventCancel?: boolean }) {
        const reader = this.getReader();
        let done = false;
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) {
              done = true;
              return;
            }
            yield r.value;
          }
        } finally {
          // Early exit (break/throw) cancels the stream, as the native iterator does.
          if (!done && !opts?.preventCancel) await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      };
      Object.defineProperty(RS, "values", { value: values, writable: true, configurable: true });
      Object.defineProperty(RS, Symbol.asyncIterator, { value: values, writable: true, configurable: true });
    }
  }
  const AB = ArrayBuffer.prototype as unknown as { transferToFixedLength?: unknown };
  if (typeof AB.transferToFixedLength !== "function") {
    AB.transferToFixedLength = function transferToFixedLength(this: ArrayBuffer, length: number = this.byteLength) {
      const out = new ArrayBuffer(length);
      new Uint8Array(out).set(new Uint8Array(this, 0, Math.min(length, this.byteLength)));
      return out;
    };
  }
  const P = Promise as unknown as { withResolvers?: unknown };
  if (typeof P.withResolvers === "function") return;
  P.withResolvers = function withResolvers<T>() {
    let resolve!: (v: T | PromiseLike<T>) => void;
    let reject!: (e?: unknown) => void;
    const promise = new Promise<T>((a, b) => {
      resolve = a;
      reject = b;
    });
    return { promise, resolve, reject };
  };
}

function pageText(items: readonly unknown[]): string {
  const parts: string[] = [];
  for (const it of items) {
    if (typeof it !== "object" || it === null || !("str" in it)) continue;
    const item = it as { str: string; hasEOL?: boolean };
    parts.push(item.str);
    if (item.hasEOL) parts.push("\n");
  }
  return parts
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractPdf(bytes: Uint8Array, name: string, deps: PdfDeps): Promise<ExtractedDocument> {
  const { pdfjs } = deps;
  const imageOps = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject]);
  let doc: Awaited<ReturnType<Pdfjs["getDocument"]>["promise"]>;
  try {
    // pdf.js may transfer the buffer to its worker: hand it a copy.
    // pdf.js 6 no longer compiles font code with eval/new Function, so there is no switch to set.
    doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  } catch (e) {
    throw new DocumentError("E_UNREADABLE", e instanceof Error ? e.message : "unreadable PDF");
  }
  const texts: string[] = [];
  const figurePages: number[] = [];
  const scannedPages: number[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const text = pageText((await page.getTextContent()).items);
      const ops = await page.getOperatorList();
      const hasFigure = ops.fnArray.some((fn) => imageOps.has(fn));
      if (!text) scannedPages.push(n);
      else if (hasFigure) figurePages.push(n);
      texts.push(text ? `[Page ${n}]\n${text}` : `[Page ${n}]`);
      page.cleanup();
    }
  } catch (e) {
    void doc.loadingTask.destroy();
    throw new DocumentError("E_UNREADABLE", e instanceof Error ? e.message : "unreadable PDF");
  }
  // Pages to send as images, first pages first: with figures, or without text (scanned).
  const candidates = [...figurePages, ...scannedPages].sort((a, b) => a - b);
  const scannedOnly = scannedPages.length === doc.numPages;
  return {
    name,
    kind: "pdf",
    text: scannedOnly ? "" : texts.join("\n\n"),
    meta: { pages: doc.numPages },
    figureCount: candidates.length,
    figurePages,
    scannedPages,
    scannedOnly,
    images: async (limit) => {
      if (!deps.renderPage) return [];
      const out: string[] = [];
      for (const n of candidates.slice(0, Math.max(0, limit))) {
        try {
          const page = await doc.getPage(n);
          out.push(await deps.renderPage(page));
          page.cleanup();
        } catch {
          /* a page that cannot be rendered is skipped */
        }
      }
      return out;
    },
    dispose: () => {
      void doc.loadingTask.destroy();
    },
  };
}
