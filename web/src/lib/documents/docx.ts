// Word .docx through mammoth: HTML (headings, lists, tables, links) turned into plain Markdown-ish
// text, plus the embedded images (PNG/JPEG/GIF/WebP) as figure candidates for models that can see.

import { countWords } from "./format";
import { DocumentError, type ExtractedDocument } from "./types";

/** The slice of mammoth this module uses (the npm entry in Node, the same package in the browser). */
export interface MammothLike {
  /** The browser build reads `arrayBuffer`, the Node build `buffer`: both are passed. */
  convertToHtml(input: { arrayBuffer: ArrayBuffer; buffer?: Uint8Array }, options?: { convertImage?: unknown }): Promise<{ value: string }>;
  images: { imgElement(fn: (image: { contentType: string; read(encoding: "base64"): Promise<string> }) => Promise<{ src: string }>): unknown };
}

export interface DocxDeps {
  mammoth: MammothLike;
  /** Downscale/re-encode one embedded image (browser); identity in tests. Returns standard base64. */
  prepare?: (base64: string, mime: string) => Promise<string>;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

export async function extractDocx(bytes: Uint8Array, name: string, deps: DocxDeps): Promise<ExtractedDocument> {
  const embedded: { mime: string; base64: string }[] = [];
  let html: string;
  try {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const res = await deps.mammoth.convertToHtml(
      { arrayBuffer: buffer, buffer: bytes },
      {
        convertImage: deps.mammoth.images.imgElement(async (image) => {
          const mime = image.contentType.toLowerCase();
          if (IMAGE_TYPES.has(mime)) embedded.push({ mime: mime === "image/jpg" ? "image/jpeg" : mime, base64: await image.read("base64") });
          return { src: "" };
        }),
      },
    );
    html = res.value;
  } catch (e) {
    throw new DocumentError("E_UNREADABLE", e instanceof Error ? e.message : "unreadable document");
  }
  const text = htmlToText(html);
  if (!text && embedded.length === 0) throw new DocumentError("E_EMPTY", "the document has no text");
  const prepare = deps.prepare ?? (async (b64: string) => b64);
  return {
    name,
    kind: "docx",
    text,
    meta: { words: countWords(text) },
    figureCount: embedded.length,
    figurePages: [],
    scannedPages: [],
    scannedOnly: false,
    images: async (limit) => {
      const out: string[] = [];
      for (const img of embedded.slice(0, Math.max(0, limit))) {
        try {
          out.push(await prepare(img.base64, img.mime));
        } catch {
          /* an image that cannot be prepared is skipped */
        }
      }
      return out;
    },
    dispose: () => {
      embedded.length = 0;
    },
  };
}

// ── HTML (mammoth's small subset) → text ─────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Headings → `#`, list items → `- ` / `1. ` (indented by depth), table rows → `| a | b |`,
 * paragraphs separated by a blank line, `<br>` → newline. Everything else keeps only its text.
 */
export function htmlToText(html: string): string {
  const out: string[] = [];
  let line = "";
  const lists: { ordered: boolean; n: number }[] = [];
  let row: string[] | null = null;
  let cell: string | null = null;
  let href: string | null = null;
  const flush = (blank: boolean) => {
    // Keep the list indentation; collapse whitespace inside the line.
    const indent = /^ */.exec(line)?.[0] ?? "";
    const body = line.slice(indent.length).replace(/[ \t]+/g, " ").trim();
    const t = body ? indent + body : "";
    if (t) out.push(t);
    if (blank && out.length > 0 && out[out.length - 1] !== "") out.push("");
    line = "";
  };
  const append = (s: string) => {
    if (cell !== null) cell += s;
    else line += s;
  };
  const re = /<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi;
  for (const m of html.matchAll(re)) {
    const text = m[4];
    if (text !== undefined) {
      append(decodeEntities(text));
      continue;
    }
    const closing = m[1] === "/";
    const tag = (m[2] ?? "").toLowerCase();
    const attrs = m[3] ?? "";
    if (/^h[1-6]$/.test(tag)) {
      if (closing) flush(true);
      else {
        flush(true);
        line = "#".repeat(Number(tag[1])) + " ";
      }
    } else if (tag === "p") {
      if (cell !== null) {
        if (closing) cell += " "; // paragraphs inside a table cell only separate words
      } else if (closing) flush(lists.length === 0);
      else if (lists.length === 0) flush(false);
    } else if (tag === "ul" || tag === "ol") {
      if (closing) {
        lists.pop();
        if (lists.length === 0) flush(true);
      } else {
        flush(false);
        lists.push({ ordered: tag === "ol", n: 0 });
      }
    } else if (tag === "li") {
      if (closing) flush(false);
      else {
        flush(false);
        const top = lists[lists.length - 1];
        if (top) top.n += 1;
        line = "  ".repeat(Math.max(0, lists.length - 1)) + (top?.ordered ? `${top.n}. ` : "- ");
      }
    } else if (tag === "br") {
      if (cell !== null) cell += " ";
      else flush(false);
    } else if (tag === "table") {
      flush(true);
    } else if (tag === "tr") {
      if (closing && row) {
        out.push(`| ${row.join(" | ")} |`);
        row = null;
      } else if (!closing) row = [];
    } else if (tag === "td" || tag === "th") {
      if (closing) {
        row?.push((cell ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim());
        cell = null;
      } else cell = "";
    } else if (tag === "a") {
      if (closing) {
        if (href && !href.startsWith("#")) append(` (${href})`);
        href = null;
      } else href = /href="([^"]*)"/i.exec(attrs)?.[1] ?? null;
    }
  }
  flush(true);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
