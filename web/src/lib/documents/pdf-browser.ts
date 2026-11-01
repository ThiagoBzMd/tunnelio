// Browser side of the PDF extractor: the pdf.js build with its worker (served by Vite as a separate
// asset) and the canvas renderer for pages sent as images. Loaded only when a PDF is attached.

import "./pdf-polyfills";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { LIMITS } from "../../protocol/constants";
import { bytesToBase64 } from "../images";
import { extractPdf, type PdfPage } from "./pdf";
import PdfWorker from "./pdf-worker?worker";
import type { ExtractedDocument } from "./types";

/** Long side of a page image (SPEC §7.7). */
export const PAGE_IMAGE_MAX_SIDE = 1600;
const QUALITIES = [0.85, 0.72, 0.6, 0.45];

// One worker for the page's lifetime (pdf.js reuses the port for every document).
let workerPort: Worker | null = null;
function ensureWorker(): void {
  if (workerPort) return;
  workerPort = new PdfWorker();
  pdfjs.GlobalWorkerOptions.workerPort = workerPort;
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/** Page → JPEG, long side ≤ 1600 px, white background, quality lowered until ≤ 4 MiB. */
export async function renderPageJpeg(page: PdfPage): Promise<string> {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(4, PAGE_IMAGE_MAX_SIDE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2D canvas");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try {
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    for (const q of QUALITIES) {
      const blob = await toBlob(canvas, q);
      if (blob && blob.size <= LIMITS.MAX_IMAGE_BYTES) return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    }
    throw new Error("page image exceeds 4 MiB");
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function extractPdfInBrowser(bytes: Uint8Array, name: string): Promise<ExtractedDocument> {
  ensureWorker();
  return extractPdf(bytes, name, { pdfjs, renderPage: renderPageJpeg });
}
