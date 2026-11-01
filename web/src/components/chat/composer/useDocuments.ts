// Documents attached to the draft (SPEC §7.7): read in the browser (the extractors load on first
// use) and sent with every model. Which drafts are still wanted, and their parsed documents, are
// kept in refs and every decision about a just-read document is made from those refs — never
// inside a React state updater: React may run an updater later (other updates pending), so a
// flag set there was read as "removed" and a freshly read PDF got closed before its pages could
// be drawn.

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/i18n";
import { documentKindOf, MAX_DOCUMENT_BYTES } from "@/lib/documents/kinds";
import { DocumentError, type ExtractedDocument } from "@/lib/documents/types";

export interface DocumentDraft {
  id: string;
  name: string;
  /** `null` while it is being read. */
  doc: ExtractedDocument | null;
}

let documentSeq = 0;

/** Forget every draft and release what was parsed (pdf.js documents hold memory). */
function release(live: Set<string>, parsed: Map<string, ExtractedDocument>): void {
  live.clear();
  for (const doc of parsed.values()) doc.dispose();
  parsed.clear();
}

export function useDocuments() {
  const { t } = useT();
  const [documents, setDocuments] = useState<DocumentDraft[]>([]);
  /** Ids of the drafts still wanted (a document read after its id left this set is disposed). */
  const liveDocs = useRef(new Set<string>());
  /** Parsed documents by draft id, so they can be released without going through state. */
  const parsedDocs = useRef(new Map<string, ExtractedDocument>());

  const disposeDoc = (id: string): void => {
    parsedDocs.current.get(id)?.dispose();
    parsedDocs.current.delete(id);
  };

  const addDocuments = async (files: File[]): Promise<void> => {
    await Promise.all(
      files.map(async (file) => {
        const name = file.name || "document";
        if (!documentKindOf(file)) return toast.error(t("chat.docUnsupported", { name }));
        if (file.size > MAX_DOCUMENT_BYTES) return toast.error(t("chat.docTooBig", { name }));
        const id = `doc-${++documentSeq}`;
        liveDocs.current.add(id);
        setDocuments((cur) => [...cur, { id, name, doc: null }]);
        try {
          const { extractDocument } = await import("@/lib/documents/extract");
          const doc = await extractDocument(file);
          if (!liveDocs.current.has(id)) {
            doc.dispose(); // removed (or sent) while it was being read
            return;
          }
          parsedDocs.current.set(id, doc);
          setDocuments((cur) => cur.map((d) => (d.id === id ? { ...d, doc } : d)));
        } catch (e) {
          liveDocs.current.delete(id);
          setDocuments((cur) => cur.filter((d) => d.id !== id));
          if (e instanceof DocumentError && e.code === "E_EMPTY") toast.error(t("chat.docEmpty", { name }));
          else if (e instanceof DocumentError && e.code === "E_TOO_LARGE") toast.error(t("chat.docTooBig", { name }));
          else {
            // Keep the technical reason visible (second line): reading happens in the user's browser,
            // so this is the only way a failure on someone's phone can be diagnosed.
            const detail = e instanceof Error ? `${e.name === "Error" ? "" : `${e.name}: `}${e.message}` : String(e);
            console.warn("[documents] could not read", name, e);
            toast.error(t("chat.docFailed", { name }), { description: detail.slice(0, 200) });
          }
        }
      }),
    );
  };

  const removeDocument = (id: string): void => {
    liveDocs.current.delete(id);
    disposeDoc(id);
    setDocuments((cur) => cur.filter((d) => d.id !== id));
  };

  /** After a successful send: drafts still being read are disposed on arrival, parsed ones now. */
  const clear = (): void => {
    release(liveDocs.current, parsedDocs.current);
    setDocuments([]);
  };

  // Release parsed documents when the composer goes away.
  useEffect(() => {
    const live = liveDocs.current;
    const parsed = parsedDocs.current;
    return () => release(live, parsed);
  }, []);

  const readyDocs = useMemo(() => documents.flatMap((d) => (d.doc ? [d.doc] : [])), [documents]);
  const reading = documents.some((d) => d.doc === null);

  return { documents, readyDocs, reading, addDocuments, removeDocument, clear };
}
