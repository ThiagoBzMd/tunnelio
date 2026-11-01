// Document chips (SPEC §7.7): the bubble never shows a document's raw text — a chip such as
// "contrato.pdf · 12 pages" that expands to the extracted text, plus a note when pages with figures
// did not go as images. The composer uses the compact, removable variant.

import { useState } from "react";
import { ChevronDownIcon, FileSpreadsheetIcon, FileTextIcon, Loader2Icon, XIcon } from "lucide-react";
import { cn } from "cn";
import { localeOf, useT, type TKey } from "@/i18n";
import type { DocumentBlock, DocumentKind, DocumentMeta } from "@/lib/documents/format";

type T = (key: TKey, vars?: Record<string, string | number>) => string;

function counted(t: T, n: number, one: TKey, many: TKey, locale: string): string {
  return n === 1 ? t(one) : t(many, { n: n.toLocaleString(locale) });
}

/** "12 pages" / "3 sheets · 1,240 rows" / "4,300 words". */
export function documentSummary(kind: DocumentKind, meta: DocumentMeta, t: T, locale: string): string {
  if (kind === "pdf" && meta.pages !== undefined) return counted(t, meta.pages, "chat.docPage", "chat.docPages", locale);
  if (kind === "sheet") {
    const parts: string[] = [];
    if (meta.sheets !== undefined) parts.push(counted(t, meta.sheets, "chat.docSheet", "chat.docSheets", locale));
    if (meta.rows !== undefined) parts.push(counted(t, meta.rows, "chat.docRow", "chat.docRows", locale));
    return parts.join(" · ");
  }
  if (meta.words !== undefined) return counted(t, meta.words, "chat.docWord", "chat.docWords", locale);
  return "";
}

export function skippedNote(kind: DocumentKind, skipped: number | undefined, t: T, locale: string): string | null {
  if (!skipped) return null;
  return kind === "pdf" ? counted(t, skipped, "chat.docSkippedPage", "chat.docSkippedPages", locale) : counted(t, skipped, "chat.docSkippedImage", "chat.docSkippedImages", locale);
}

function KindIcon({ kind, className }: { kind: DocumentKind; className?: string }) {
  return kind === "sheet" ? <FileSpreadsheetIcon className={className} /> : <FileTextIcon className={className} />;
}

/** In a sent message: expands to the extracted text. */
export function DocumentChip({ doc }: { doc: DocumentBlock }) {
  const { t, lang } = useT();
  const [open, setOpen] = useState(false);
  const locale = localeOf(lang);
  const summary = documentSummary(doc.kind, doc.meta, t, locale);
  const note = skippedNote(doc.kind, doc.meta.skipped_figures, t, locale);
  return (
    <div className="w-full max-w-[85%] self-end" data-testid="document-chip" data-kind={doc.kind} data-name={doc.name}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? t("chat.docHide") : t("chat.docShow")}
        className="ml-auto flex max-w-full items-center gap-2 rounded-xl border bg-card px-3 py-2 text-left text-sm shadow-xs hover:bg-muted/50"
        data-testid="document-chip-toggle"
      >
        <KindIcon kind={doc.kind} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium">{doc.name}</span>
        {summary ? <span className="shrink-0 text-muted-foreground">· {summary}</span> : null}
        <ChevronDownIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {note ? (
        <p className="mt-1 text-right text-xs text-muted-foreground" data-testid="document-note">
          {note}
        </p>
      ) : null}
      {open ? (
        <pre className="mt-1.5 max-h-80 overflow-auto rounded-xl border bg-muted/30 p-3 text-xs leading-relaxed whitespace-pre-wrap" data-testid="document-text">
          {doc.text}
        </pre>
      ) : null}
    </div>
  );
}

/** In the composer: reading spinner, then the summary; removable. */
export function DraftDocumentChip({ name, kind, meta, reading, onRemove }: { name: string; kind: DocumentKind | null; meta: DocumentMeta | null; reading: boolean; onRemove(): void }) {
  const { t, lang } = useT();
  const summary = kind && meta ? documentSummary(kind, meta, t, localeOf(lang)) : "";
  return (
    <div className="flex h-9 max-w-full items-center gap-2 rounded-lg border bg-muted/40 pr-1 pl-2.5 text-xs" data-testid="draft-document" data-state={reading ? "reading" : "ready"} data-name={name}>
      {reading ? <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : <KindIcon kind={kind ?? "text"} className="size-3.5 shrink-0 text-muted-foreground" />}
      <span className="max-w-48 truncate font-medium">{name}</span>
      {summary ? <span className="shrink-0 text-muted-foreground">· {summary}</span> : null}
      <button type="button" onClick={onRemove} aria-label={t("chat.removeDocument")} className="ml-0.5 rounded-full p-1 text-muted-foreground hover:bg-background hover:text-foreground" data-testid="draft-document-remove">
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
