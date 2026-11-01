// Image attachments for vision models: client-side downscale + re-encode before the bytes travel
// (base64, standard alphabet with padding, no data-URL prefix — byte-exact with the tray), plus
// the DOM-free helpers used by validation and rendering (base64 length math, MIME sniffing).
//
// `prepareImage` needs a browser (createImageBitmap/<img> + canvas); everything else runs in Node.

import { LIMITS } from "../protocol/constants";

/** Long edge after downscale: what current vision models consume without re-tiling. */
export const MAX_IMAGE_EDGE = 1568;
export const JPEG_QUALITY = 0.85;
/** Refuse to even decode absurdly large sources (memory), long before the 4 MiB output cap. */
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export type ImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export interface PreparedImage {
  /** Standard base64 (RFC 4648 with padding) of the encoded bytes, no `data:` prefix. */
  base64: string;
  mime: ImageMime;
  width: number;
  height: number;
  /** Decoded (encoded-image) size in bytes. */
  bytes: number;
}

export type ImageErrorCode = "E_DECODE" | "E_TOO_LARGE" | "E_UNSUPPORTED";

export class ImageError extends Error {
  constructor(
    public readonly code: ImageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImageError";
  }
}

// ── base64 (DOM-free) ────────────────────────────────────────────────────────

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Standard alphabet, padded to a multiple of 4 (what the tray decodes with `base64.StdEncoding`). */
export function isStandardBase64(s: string): boolean {
  return s.length > 0 && s.length % 4 === 0 && B64_RE.test(s);
}

/** Decoded byte length from the base64 length alone (no decoding). 0 for malformed input. */
export function base64DecodedLength(s: string): number {
  if (s.length === 0 || s.length % 4 !== 0) return 0;
  let padding = 0;
  if (s.endsWith("==")) padding = 2;
  else if (s.endsWith("=")) padding = 1;
  return (s.length / 4) * 3 - padding;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += B64_ALPHABET[(n >> 18) & 63]! + B64_ALPHABET[(n >> 12) & 63]! + B64_ALPHABET[(n >> 6) & 63]! + B64_ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += B64_ALPHABET[(n >> 18) & 63]! + B64_ALPHABET[(n >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += B64_ALPHABET[(n >> 18) & 63]! + B64_ALPHABET[(n >> 12) & 63]! + B64_ALPHABET[(n >> 6) & 63]! + "=";
  }
  return out;
}

/** Decode up to `max` bytes (whole string when omitted). Throws `ImageError(E_DECODE)` on bad input. */
export function base64ToBytes(s: string, max?: number): Uint8Array {
  if (!isStandardBase64(s)) throw new ImageError("E_DECODE", "malformed base64");
  const total = base64DecodedLength(s);
  const want = max === undefined ? total : Math.min(max, total);
  const out = new Uint8Array(want);
  let o = 0;
  for (let i = 0; i < s.length && o < want; i += 4) {
    const a = B64_ALPHABET.indexOf(s[i]!);
    const b = B64_ALPHABET.indexOf(s[i + 1]!);
    const c = s[i + 2] === "=" ? 0 : B64_ALPHABET.indexOf(s[i + 2]!);
    const d = s[i + 3] === "=" ? 0 : B64_ALPHABET.indexOf(s[i + 3]!);
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (n >> 16) & 255;
    if (o < want) out[o++] = (n >> 8) & 255;
    if (o < want) out[o++] = n & 255;
  }
  return out;
}

// ── MIME sniffing (DOM-free) ─────────────────────────────────────────────────

/** Detect JPEG/PNG/GIF/WebP from the magic bytes; `null` for anything else or malformed base64. */
export function sniffMime(base64: string): ImageMime | null {
  let head: Uint8Array;
  try {
    head = base64ToBytes(base64.slice(0, 16), 12);
  } catch {
    return null;
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) {
    return "image/png";
  }
  if (head.length >= 6 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38 && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) {
    return "image/gif";
  }
  if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

/** `data:<mime>;base64,…` for `<img src>`; falls back to a generic type when sniffing fails. */
export function imageDataUrl(base64: string): string {
  return `data:${sniffMime(base64) ?? "application/octet-stream"};base64,${base64}`;
}

/** Blob for `URL.createObjectURL` (open full size in a new tab). */
export function base64ToBlob(base64: string): Blob {
  return new Blob([base64ToBytes(base64) as BlobPart], { type: sniffMime(base64) ?? "application/octet-stream" });
}

/**
 * Same check the chat request runs before encryption. Returns an error code or `null`.
 * (`decoded` is derived from the base64 length, so it never allocates the image.)
 */
export function checkImage(base64: string): ImageErrorCode | null {
  if (!isStandardBase64(base64) || base64.startsWith("data:")) return "E_DECODE";
  if (base64DecodedLength(base64) > LIMITS.MAX_IMAGE_BYTES) return "E_TOO_LARGE";
  return null;
}

// ── browser: decode → downscale → re-encode ──────────────────────────────────

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

async function decodeBlob(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall back to <img> (some browsers reject formats here that <img> still decodes) */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new ImageError("E_DECODE", "not a decodable image"));
      el.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function hasTransparency(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const data = ctx.getImageData(0, 0, width, height).data;
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] as number) < 255) return true;
  }
  return false;
}

function encodeCanvas(canvas: HTMLCanvasElement, mime: ImageMime): { base64: string; mime: ImageMime } {
  const dataUrl = canvas.toDataURL(mime, JPEG_QUALITY);
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) throw new ImageError("E_DECODE", "canvas encoding failed");
  const base64 = dataUrl.slice(comma + 1);
  // Browsers silently fall back to PNG for an unsupported type: trust the bytes, not the request.
  return { base64, mime: sniffMime(base64) ?? mime };
}

/**
 * Decode any browser-readable image, downscale so the long edge is ≤ 1568 px and re-encode:
 * JPEG q0.85 for everything (over white, so transparent GIF/WebP do not turn black), except a
 * PNG with real transparency, which stays PNG. Resolves with standard base64 and the dimensions.
 */
export async function prepareImage(file: File | Blob): Promise<PreparedImage> {
  if (file.size > MAX_SOURCE_BYTES) throw new ImageError("E_TOO_LARGE", "source image is too large");
  const decoded = await decodeBlob(file);
  try {
    if (decoded.width <= 0 || decoded.height <= 0) throw new ImageError("E_DECODE", "empty image");
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ImageError("E_UNSUPPORTED", "canvas 2d context unavailable");
    ctx.drawImage(decoded.source, 0, 0, width, height);

    const keepPng = file.type === "image/png" && hasTransparency(ctx, width, height);
    let out: { base64: string; mime: ImageMime };
    if (keepPng) {
      out = encodeCanvas(canvas, "image/png");
      if (base64DecodedLength(out.base64) > LIMITS.MAX_IMAGE_BYTES) out = { base64: "", mime: "image/jpeg" }; // too big: give up transparency
    } else {
      out = { base64: "", mime: "image/jpeg" };
    }
    if (out.base64 === "") {
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = "source-over";
      out = encodeCanvas(canvas, "image/jpeg");
    }
    const bytes = base64DecodedLength(out.base64);
    if (bytes === 0) throw new ImageError("E_DECODE", "canvas produced no data");
    if (bytes > LIMITS.MAX_IMAGE_BYTES) throw new ImageError("E_TOO_LARGE", "image is too large after compression");
    return { base64: out.base64, mime: out.mime, width, height, bytes };
  } finally {
    decoded.close();
  }
}
