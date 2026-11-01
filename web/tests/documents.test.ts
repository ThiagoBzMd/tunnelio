// @vitest-environment node
// Documents in the chat (SPEC §7.7): the <document> block format, file kinds, the model memory
// rule, every extractor against generated fixtures, and how a message is composed.

import { beforeAll, describe, expect, it } from "vitest";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { ANSWER_RESERVE_TOKENS, estimateTokens, planContext } from "../src/lib/context";
import { composeMessage, draftChars, draftIssues } from "../src/lib/documents/compose";
import { extractDocx, htmlToText, type MammothLike } from "../src/lib/documents/docx";
import { composeContent, countWords, escapeAttr, parseContent, wrapDocument, type DocumentBlock } from "../src/lib/documents/format";
import { DOCUMENT_ACCEPT, documentKindOf, isImageFile } from "../src/lib/documents/kinds";
import { ensurePdfjsPolyfills, extractPdf, type Pdfjs } from "../src/lib/documents/pdf";
import { extractSheet } from "../src/lib/documents/sheet";
import { extractText } from "../src/lib/documents/text";
import { DocumentError, textOnly, type ExtractedDocument } from "../src/lib/documents/types";
import { makeDocx, makePdf, makeXlsx, solidPng } from "./helpers/doc-fixtures";

let pdfjs: Pdfjs;
beforeAll(async () => {
  ensurePdfjsPolyfills();
  pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
});

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("<document> blocks", () => {
  const pdf: DocumentBlock = { name: 'contrato "final" <v2> & co.pdf', kind: "pdf", meta: { pages: 12 }, text: "[Page 1]\nCláusula 1" };
  const sheet: DocumentBlock = { name: "vendas.xlsx", kind: "sheet", meta: { sheets: 3, rows: 1240 }, text: "## Jan\na,b" };

  it("wraps with escaped attributes, documents before the prompt", () => {
    expect(escapeAttr('a<b>&"c"')).toBe("a&lt;b&gt;&amp;&quot;c&quot;");
    expect(wrapDocument(pdf)).toBe('<document name="contrato &quot;final&quot; &lt;v2&gt; &amp; co.pdf" kind="pdf" pages="12">\n[Page 1]\nCláusula 1\n</document>');
    const content = composeContent([pdf, sheet], "Resuma");
    expect(content.endsWith("</document>\n\nResuma")).toBe(true);
    expect(content.indexOf('kind="sheet" sheets="3" rows="1240"')).toBeGreaterThan(0);
    expect(composeContent([], "só texto")).toBe("só texto");
    expect(composeContent([sheet], "")).toBe(wrapDocument(sheet));
  });

  it("parses blocks back (round trip), including the reload-from-history case", () => {
    const content = composeContent([pdf, sheet], "Resuma\n\nem português");
    expect(parseContent(content)).toEqual({ documents: [pdf, sheet], prompt: "Resuma\n\nem português" });
    expect(parseContent(composeContent([pdf], ""))).toEqual({ documents: [pdf], prompt: "" });
    // Messages without documents (all of them before rev. 1.4) are untouched.
    expect(parseContent("oi")).toEqual({ documents: [], prompt: "oi" });
    expect(parseContent("<document>not a block")).toEqual({ documents: [], prompt: "<document>not a block" });
    expect(parseContent('<document name="x" kind="video">\nx\n</document>')).toEqual({ documents: [], prompt: '<document name="x" kind="video">\nx\n</document>' });
  });

  it("keeps a closing tag inside the text from ending the block", () => {
    const tricky: DocumentBlock = { name: "html.md", kind: "text", meta: { words: 2 }, text: "before </document> after" };
    const content = composeContent([tricky], "?");
    expect(content).toContain("<\\/document>");
    expect(parseContent(content)).toEqual({ documents: [tricky], prompt: "?" });
  });

  it("records figures that did not go as images only when there are any", () => {
    expect(wrapDocument({ ...pdf, meta: { pages: 2, skipped_figures: 0 } })).not.toContain("skipped_figures");
    const withNote = { ...pdf, meta: { pages: 2, skipped_figures: 2 } };
    expect(wrapDocument(withNote)).toContain('skipped_figures="2"');
    expect(parseContent(wrapDocument(withNote)).documents[0]?.meta).toEqual({ pages: 2, skipped_figures: 2 });
  });
});

describe("file kinds", () => {
  it("maps extensions and MIME types; images stay images", () => {
    const k = (name: string, type = "") => documentKindOf({ name, type });
    expect([k("a.PDF"), k("x", "application/pdf"), k("b.docx"), k("c.xlsx"), k("d.xls"), k("e.ods"), k("f.csv")]).toEqual(["pdf", "pdf", "docx", "sheet", "sheet", "sheet", "sheet"]);
    expect([k("g.txt"), k("h.md"), k("main.py"), k("app.tsx"), k("data.json"), k("notes", "text/plain")]).toEqual(["text", "text", "text", "text", "text", "text"]);
    expect([k("movie.mp4", "video/mp4"), k("archive.zip"), k("old.doc")]).toEqual([null, null, null]);
    expect(isImageFile({ name: "p.png", type: "image/png" })).toBe(true);
    for (const ext of [".pdf", ".docx", ".xlsx", ".ods", ".csv", ".md", ".py", ".json"]) expect(DOCUMENT_ACCEPT.split(",")).toContain(ext);
  });
});

describe("model memory (num_ctx)", () => {
  it("estimates ceil(chars / 3.5) + 2048", () => {
    expect(estimateTokens(0)).toBe(ANSWER_RESERVE_TOKENS);
    expect(estimateTokens(7)).toBe(2 + 2048);
    expect(estimateTokens(8)).toBe(3 + 2048);
  });
  it("leaves small conversations to Ollama, grows num_ctx by doubling, caps at the model, blocks above it", () => {
    expect(planContext(7000, 32768)).toEqual({ ok: true, estimate: 4048 }); // ≤ 4096: nothing
    expect(planContext(7175, 32768)).toEqual({ ok: true, estimate: 4098, num_ctx: 8192 });
    expect(planContext(35000, 32768)).toEqual({ ok: true, estimate: 12048, num_ctx: 16384 });
    expect(planContext(100_000, 32768)).toEqual({ ok: true, estimate: 30620, num_ctx: 32768 });
    expect(planContext(106_000, 32768)).toEqual({ ok: true, estimate: 32334, num_ctx: 32768 });
    expect(planContext(107_000, 32768)).toEqual({ ok: true, estimate: 32620, num_ctx: 32768 }); // still fits
    expect(planContext(100_000, 24000)).toMatchObject({ ok: false }); // over a max that is not a power of two
    expect(planContext(70_000, 24000)).toEqual({ ok: true, estimate: 22048, num_ctx: 24000 }); // capped at the max
    expect(planContext(108_000, 32768)).toEqual({ ok: false, reason: "too_long", estimate: 32906, max: 32768 });
    expect(planContext(400_000, 32768)).toMatchObject({ ok: false, reason: "too_long", max: 32768 });
    // A model whose whole memory is 2048 tokens (moondream) keeps a quarter of it for the answer.
    expect(planContext(100, 2048)).toEqual({ ok: true, estimate: 29 + 512 });
    expect(planContext(5300, 2048)).toEqual({ ok: true, estimate: 1515 + 512 });
    expect(planContext(6000, 2048)).toMatchObject({ ok: false, reason: "too_long", estimate: 1715 + 512 });
  });

  it("keeps the context Ollama has the model loaded with whenever the conversation fits in it", () => {
    // Loaded by Ollama's own choice (e.g. 32k on a computer with 24–48 GB of video memory): kept, no reload.
    expect(planContext(7000, 131072, 32768)).toEqual({ ok: true, estimate: 4048, num_ctx: 32768 });
    expect(planContext(35000, 131072, 32768)).toEqual({ ok: true, estimate: 12048, num_ctx: 32768 });
    // Does not fit: the next power of two, once.
    expect(planContext(35000, 131072, 8192)).toEqual({ ok: true, estimate: 12048, num_ctx: 16384 });
    expect(planContext(7000, 32768, 2048)).toEqual({ ok: true, estimate: 4048, num_ctx: 4096 });
    // The model's max still blocks; an unknown max leaves everything to Ollama.
    expect(planContext(108_000, 32768, 32768)).toMatchObject({ ok: false, reason: "too_long" });
    expect(planContext(35000, null, 8192)).toEqual({ ok: true, estimate: 12048 });
    // Unknown maximum: behave as before (no num_ctx, never blocked).
    expect(planContext(400_000, null)).toEqual({ ok: true, estimate: estimateTokens(400_000) });
  });
});

describe("text extractor", () => {
  it("decodes UTF-8, drops the BOM, normalises line ends, counts words", () => {
    const doc = extractText(utf8("﻿olá mundo\r\nsegunda linha\rterceira"), "notes.md");
    expect(doc).toMatchObject({ name: "notes.md", kind: "text", text: "olá mundo\nsegunda linha\nterceira", meta: { words: 5 }, figureCount: 0, scannedOnly: false });
    expect(countWords("  a  b\n\nc ")).toBe(3);
  });
  it("refuses binary content and empty files", () => {
    expect(() => extractText(new Uint8Array([0x50, 0x00, 0x4b]), "x.log")).toThrow(DocumentError);
    expect(() => extractText(utf8("  \n "), "empty.txt")).toThrow(expect.objectContaining({ code: "E_EMPTY" }));
  });
});

describe("spreadsheet extractor (SheetJS)", () => {
  it("turns every sheet into CSV under its name and counts rows", () => {
    const bytes = makeXlsx({ Jan: [["produto", "qtd"], ["maçã", 3], ["pera", 5]], Fev: [["produto", "qtd"], ["uva", 7]] });
    const doc = extractSheet(bytes, "vendas.xlsx", XLSX);
    expect(doc.kind).toBe("sheet");
    expect(doc.meta).toEqual({ sheets: 2, rows: 5 });
    expect(doc.text).toBe("## Jan\nproduto,qtd\nmaçã,3\npera,5\n\n## Fev\nproduto,qtd\nuva,7");
  });
  it("reads CSV files and refuses empty ones", () => {
    expect(extractSheet(utf8("a,b\n1,2\n"), "t.csv", XLSX).meta).toEqual({ sheets: 1, rows: 2 });
    expect(() => extractSheet(utf8(""), "empty.csv", XLSX)).toThrow(expect.objectContaining({ code: "E_EMPTY" }));
  });
});

describe("docx extractor (mammoth)", () => {
  it("keeps headings, lists, tables and links as plain Markdown-ish text", () => {
    expect(htmlToText('<h2>Título &amp; mais &#233;&#x41;</h2><p>Texto <a href="https://x.y">link</a>.</p><ol><li>um</li><li>dois<ul><li>sub</li></ul></li></ol><table><tr><td>a|b</td><td>c</td></tr></table>')).toBe(
      "## Título & mais éA\n\nTexto link (https://x.y).\n\n1. um\n2. dois\n  - sub\n\n| a\\|b | c |",
    );
  });
  it("extracts text and embedded images from a generated .docx", async () => {
    const bytes = await makeDocx({ heading: "Quarterly report", paragraphs: ["Revenue grew <fast> & steady."], bullets: ["alpha", "beta"], numbered: ["first"], table: [["Name", "Qty"], ["apples", "3"]], images: [[255, 0, 0], [0, 0, 255]] });
    const doc = await extractDocx(bytes, "report.docx", { mammoth: mammoth as unknown as MammothLike });
    expect(doc.text).toBe("# Quarterly report\n\nRevenue grew <fast> & steady.\n\n- alpha\n- beta\n\n1. first\n\n| Name | Qty |\n| apples | 3 |");
    expect(doc.meta.words).toBe(countWords(doc.text));
    expect(doc.figureCount).toBe(2);
    const imgs = await doc.images(1);
    expect(imgs).toHaveLength(1);
    expect(Buffer.from(imgs[0]!, "base64").subarray(1, 4).toString()).toBe("PNG");
  });
  it("refuses something that is not a .docx", async () => {
    await expect(extractDocx(utf8("hello"), "fake.docx", { mammoth: mammoth as unknown as MammothLike })).rejects.toMatchObject({ code: "E_UNREADABLE" });
  });
});

describe("PDF extractor (pdf.js)", () => {
  it("reads every page's text, finds figure pages and scanned pages", async () => {
    const bytes = await makePdf([{ text: ["Contract zebrafruit", "Clause one"] }, { text: ["Chart below"], image: [255, 0, 0] }, { image: [0, 0, 255] }, { text: ["The end"] }]);
    const doc = await extractPdf(bytes, "contrato.pdf", { pdfjs });
    expect(doc).toMatchObject({ kind: "pdf", meta: { pages: 4 }, figurePages: [2], scannedPages: [3], figureCount: 2, scannedOnly: false });
    expect(doc.text).toContain("[Page 1]\nContract zebrafruit");
    expect(doc.text).toContain("[Page 2]\nChart below");
    expect(doc.text).toContain("[Page 3]\n\n[Page 4]\nThe end");
    expect(await doc.images(4)).toEqual([]); // no renderer injected (Node)
    doc.dispose();
  });
  it("renders only the candidate pages, first pages first, up to the limit", async () => {
    const bytes = await makePdf([{ image: [1, 1, 1] }, { text: ["x"] }, { text: ["y"], image: [2, 2, 2] }, { image: [3, 3, 3] }]);
    const rendered: number[] = [];
    const doc = await extractPdf(bytes, "scan.pdf", {
      pdfjs,
      renderPage: async (page) => {
        rendered.push(page.pageNumber);
        return `page${page.pageNumber}`;
      },
    });
    expect(doc.figureCount).toBe(3);
    expect(await doc.images(2)).toEqual(["page1", "page3"]);
    expect(rendered).toEqual([1, 3]);
    doc.dispose();
  });
  it("marks a PDF without any text as scanned only", async () => {
    const doc = await extractPdf(await makePdf([{ image: [9, 9, 9] }, { image: [8, 8, 8] }]), "scan.pdf", { pdfjs });
    expect(doc).toMatchObject({ scannedOnly: true, text: "", scannedPages: [1, 2], figureCount: 2 });
    doc.dispose();
  });
  it("reads text where ReadableStream is not async-iterable (Safari)", async () => {
    const RS = ReadableStream.prototype as unknown as Record<PropertyKey, unknown>;
    const native = { iter: RS[Symbol.asyncIterator], values: RS.values };
    delete RS[Symbol.asyncIterator];
    delete RS.values;
    try {
      ensurePdfjsPolyfills();
      expect(RS[Symbol.asyncIterator]).not.toBe(native.iter);
      const doc = await extractPdf(await makePdf([{ text: ["Safari kiwi"] }, { text: ["Page two"] }]), "ios.pdf", { pdfjs });
      expect(doc.text).toBe("[Page 1]\nSafari kiwi\n\n[Page 2]\nPage two");
      doc.dispose();
      // Leaving the loop early cancels the stream.
      let cancelled = false;
      const stream = new ReadableStream<number>({ pull: (c) => c.enqueue(1), cancel: () => void (cancelled = true) });
      for await (const _ of stream as unknown as AsyncIterable<number>) break;
      expect(cancelled).toBe(true);
    } finally {
      Object.defineProperty(RS, Symbol.asyncIterator, { value: native.iter, writable: true, configurable: true });
      Object.defineProperty(RS, "values", { value: native.values, writable: true, configurable: true });
    }
  });
  it("refuses something that is not a PDF", async () => {
    await expect(extractPdf(utf8("%PDF-not really"), "bad.pdf", { pdfjs })).rejects.toMatchObject({ code: "E_UNREADABLE" });
  });
});

describe("composing a message", () => {
  const fake = (name: string, figures: number, extra: Partial<ExtractedDocument> = {}): ExtractedDocument => ({
    ...textOnly(name, "pdf", `text of ${name}`, { pages: 3 }),
    figureCount: figures,
    figurePages: Array.from({ length: figures }, (_, i) => i + 1),
    images: async (limit) => Array.from({ length: Math.min(limit, figures) }, (_, i) => `${name}-img${i + 1}`),
    ...extra,
  });

  it("photos first, then document pages in order, within the per-message limit", async () => {
    const res = await composeMessage("  Compare  ", ["photo1"], [fake("a.pdf", 2), fake("b.pdf", 3)], { vision: true, maxImages: 4 });
    expect(res.images).toEqual(["photo1", "a.pdf-img1", "a.pdf-img2", "b.pdf-img1"]);
    expect(res.blocks.map((b) => b.meta.skipped_figures)).toEqual([undefined, 2]);
    expect(parseContent(res.content)).toEqual({ documents: res.blocks, prompt: "Compare" });
  });

  it("a model that cannot see gets the text only; the note counts every figure", async () => {
    const res = await composeMessage("Q", [], [fake("a.pdf", 2)], { vision: false, maxImages: 4 });
    expect(res.images).toEqual([]);
    expect(res.blocks[0]?.meta.skipped_figures).toBe(2);
  });

  it("warns or blocks before sending to a model that cannot see", () => {
    const figures = fake("f.pdf", 1);
    const scanned = fake("s.pdf", 2, { scannedOnly: true, figurePages: [], scannedPages: [1, 2] });
    const partly = fake("p.pdf", 1, { figurePages: [], scannedPages: [2] });
    expect(draftIssues([figures], true)).toEqual({ block: null, warnings: [] });
    expect(draftIssues([figures], null)).toEqual({ block: null, warnings: [] }); // still checking
    expect(draftIssues([figures], false)).toEqual({ block: null, warnings: ["figures_warn"] });
    expect(draftIssues([scanned], false).block).toBe("scanned_block");
    expect(draftIssues([partly], false)).toEqual({ block: null, warnings: ["scanned_warn"] });
    expect(draftIssues([textOnly("t.md", "text", "x", { words: 1 })], false)).toEqual({ block: null, warnings: [] });
  });

  it("draft size = what the blocks + prompt will add", () => {
    const doc = fake("a.pdf", 0);
    expect(draftChars("hi", [doc])).toBe(composeContent([{ name: "a.pdf", kind: "pdf", meta: { pages: 3 }, text: "text of a.pdf" }], "hi").length);
  });

  it("PNG helper yields a real PNG (fixture sanity)", () => {
    expect(solidPng(2, [0, 0, 0]).subarray(1, 4).toString()).toBe("PNG");
  });
});
