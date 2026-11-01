// Documents in the chat (SPEC §7.7): the extracted text travels inside the user message `content`,
// before the typed prompt, one block per document:
//
//   <document name="contrato.pdf" kind="pdf" pages="12">
//   …text…
//   </document>
//
//   <typed prompt>
//
// The UI recognises the blocks (also in history reloaded from the computer) and shows a chip instead
// of the raw text. DOM-free; used by the composer, the bubble and the chat store.

export type DocumentKind = "pdf" | "docx" | "sheet" | "text";
export const DOCUMENT_KINDS: readonly DocumentKind[] = ["pdf", "docx", "sheet", "text"];

export interface DocumentMeta {
  /** pdf */
  pages?: number;
  /** sheet */
  sheets?: number;
  rows?: number;
  /** docx / text */
  words?: number;
  /** pdf pages with figures (or without text) / docx images that did not go as images. */
  skipped_figures?: number;
}

export interface DocumentBlock {
  name: string;
  kind: DocumentKind;
  meta: DocumentMeta;
  text: string;
}

const META_KEYS: readonly (keyof DocumentMeta)[] = ["pages", "sheets", "rows", "words", "skipped_figures"];

/** Attribute value escaping: `&`, `<`, `>` and `"` (the name is user data). */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

// A closing tag inside the text would end the block early: it is neutralised on the way in and
// restored on the way out (the model reads `<\/document>`, which is harmless).
const CLOSE = "</document>";
const CLOSE_ESCAPED = "<\\/document>";

/** One `<document …>` block. */
export function wrapDocument(doc: DocumentBlock): string {
  const attrs = [`name="${escapeAttr(doc.name)}"`, `kind="${doc.kind}"`];
  for (const k of META_KEYS) {
    const v = doc.meta[k];
    if (typeof v === "number" && Number.isFinite(v) && (k !== "skipped_figures" || v > 0)) attrs.push(`${k}="${Math.trunc(v)}"`);
  }
  return `<document ${attrs.join(" ")}>\n${doc.text.split(CLOSE).join(CLOSE_ESCAPED)}\n${CLOSE}`;
}

/** Documents first, then the typed prompt (SPEC §7.7). Without documents the prompt is unchanged. */
export function composeContent(documents: DocumentBlock[], prompt: string): string {
  const blocks = documents.map(wrapDocument).join("\n\n");
  if (!blocks) return prompt;
  return prompt ? `${blocks}\n\n${prompt}` : blocks;
}

const OPEN_RE = /^<document((?:\s+[a-z_]+="[^"]*")*)\s*>\n/;
const ATTR_RE = /([a-z_]+)="([^"]*)"/g;

function parseAttrs(raw: string): { name: string; kind: DocumentKind; meta: DocumentMeta } | null {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) attrs[m[1]!] = unescapeAttr(m[2]!);
  const kind = attrs.kind as DocumentKind;
  if (attrs.name === undefined || !DOCUMENT_KINDS.includes(kind)) return null;
  const meta: DocumentMeta = {};
  for (const k of META_KEYS) {
    const v = attrs[k];
    if (v !== undefined && /^\d+$/.test(v)) meta[k] = Number(v);
  }
  return { name: attrs.name, kind, meta };
}

/**
 * Split a user message into its leading document blocks and the typed prompt. Content without
 * blocks (every message before rev. 1.4) comes back as `{ documents: [], prompt: content }`.
 */
export function parseContent(content: string): { documents: DocumentBlock[]; prompt: string } {
  const documents: DocumentBlock[] = [];
  let rest = content;
  for (;;) {
    const open = OPEN_RE.exec(rest);
    if (!open) break;
    const head = parseAttrs(open[1] ?? "");
    const end = rest.indexOf(`\n${CLOSE}`, open[0].length - 1);
    if (!head || end < 0) break;
    const text = rest.slice(open[0].length, end).split(CLOSE_ESCAPED).join(CLOSE);
    documents.push({ ...head, text });
    rest = rest.slice(end + CLOSE.length + 1);
    if (rest.startsWith("\n\n")) rest = rest.slice(2);
    else if (rest.length > 0 && !rest.startsWith("<document")) break;
  }
  if (documents.length === 0) return { documents, prompt: content };
  return { documents, prompt: rest };
}

export function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}
