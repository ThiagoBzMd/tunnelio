// @vitest-environment jsdom
// The composer's hooks rendered for real (React + jsdom). Documents: a draft removed (or sent)
// while it was still being read is disposed as soon as it arrives and never shows up — decided
// from refs, never inside a state updater (an updater may run later and see "removed" for a
// document the user still has). Limits: a scanned PDF blocks a model that cannot see, figures only
// warn, and the whole conversation plus the draft must fit the model.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocuments } from "../src/components/chat/composer/useDocuments";
import { useDraftLimits, type DraftLimitsInput } from "../src/components/chat/composer/useDraftLimits";
import { t } from "../src/i18n";
import { DocumentError, textOnly, type ExtractedDocument } from "../src/lib/documents/types";

const { extractDocument } = vi.hoisted(() => ({ extractDocument: vi.fn<(file: File) => Promise<ExtractedDocument>>() }));
vi.mock("../src/lib/documents/extract", () => ({ extractDocument }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  extractDocument.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

type Doc = ExtractedDocument & { dispose: ReturnType<typeof vi.fn> };
const doc = (name: string, over: Partial<ExtractedDocument> = {}): Doc => ({ ...textOnly(name, "text", "hello", { words: 1 }), ...over, dispose: vi.fn() });
const file = (name: string) => new File(["hello"], name, { type: "text/plain" });

type Docs = ReturnType<typeof useDocuments>;
let docs: Docs;
/** Hands the hook's latest value to the test (a probe, not a component with state of its own). */
function DocsProbe({ onRender }: { onRender(value: Docs): void }) {
  const value = useDocuments();
  onRender(value);
  return createElement(
    "ul",
    null,
    value.documents.map((d) => createElement("li", { key: d.id, "data-state": d.doc ? "ready" : "reading" }, d.name)),
  );
}
const chips = () => Array.from(host.querySelectorAll("li")).map((li) => `${li.textContent}:${li.dataset.state}`);

/** Start reading `name`; the extractor stays pending until the returned `arrive` is called. */
async function startReading(name: string): Promise<{ adding: Promise<void>; arrive(d: ExtractedDocument): Promise<void> }> {
  let resolve!: (d: ExtractedDocument) => void;
  extractDocument.mockImplementationOnce(() => new Promise<ExtractedDocument>((r) => (resolve = r)));
  let adding!: Promise<void>;
  await act(async () => {
    adding = docs.addDocuments([file(name)]);
  });
  return {
    adding,
    arrive: (d) =>
      act(async () => {
        resolve(d);
        await adding;
      }),
  };
}

describe("useDocuments", () => {
  beforeEach(async () => {
    await act(async () =>
      root.render(
        createElement(DocsProbe, {
          onRender: (value) => {
            docs = value;
          },
        }),
      ),
    );
  });

  it("shows a draft while it is read, then ready; clear (after a send) releases it", async () => {
    const d = doc("a.txt");
    const { arrive } = await startReading("a.txt");
    expect(chips()).toEqual(["a.txt:reading"]);
    expect(docs.reading).toBe(true);
    expect(docs.readyDocs).toEqual([]);
    await arrive(d);
    expect(chips()).toEqual(["a.txt:ready"]);
    expect(docs.reading).toBe(false);
    expect(docs.readyDocs).toEqual([d]);
    await act(async () => docs.clear());
    expect(chips()).toEqual([]);
    expect(d.dispose).toHaveBeenCalledTimes(1);
  });

  it("a draft removed while it is being read is disposed on arrival and never shown", async () => {
    const d = doc("slow.txt");
    const { arrive } = await startReading("slow.txt");
    const id = docs.documents[0]!.id;
    await act(async () => docs.removeDocument(id));
    expect(chips()).toEqual([]);
    expect(d.dispose).not.toHaveBeenCalled();
    await arrive(d);
    expect(chips()).toEqual([]);
    expect(docs.readyDocs).toEqual([]);
    expect(d.dispose).toHaveBeenCalledTimes(1);
  });

  it("a send while a draft is still being read disposes it on arrival too", async () => {
    const d = doc("late.txt");
    const { arrive } = await startReading("late.txt");
    await act(async () => docs.clear());
    await arrive(d);
    expect(chips()).toEqual([]);
    expect(d.dispose).toHaveBeenCalledTimes(1);
  });

  it("removing a read draft disposes it at once; unmounting releases the rest", async () => {
    const a = doc("a.txt");
    const b = doc("b.txt");
    const first = await startReading("a.txt");
    await first.arrive(a);
    const second = await startReading("b.txt");
    await second.arrive(b);
    expect(chips()).toEqual(["a.txt:ready", "b.txt:ready"]);
    await act(async () => docs.removeDocument(docs.documents[0]!.id));
    expect(chips()).toEqual(["b.txt:ready"]);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(b.dispose).toHaveBeenCalledTimes(1);
  });

  it("a file that cannot be read leaves no draft; unsupported files are refused before reading", async () => {
    extractDocument.mockRejectedValueOnce(new DocumentError("E_EMPTY", "nothing to read"));
    await act(async () => docs.addDocuments([file("empty.txt")]));
    expect(chips()).toEqual([]);
    expect(docs.reading).toBe(false);
    await act(async () => docs.addDocuments([new File(["x"], "photo.bin", { type: "application/octet-stream" })]));
    expect(extractDocument).toHaveBeenCalledTimes(1);
    expect(chips()).toEqual([]);
  });
});

describe("useDraftLimits", () => {
  type Limits = ReturnType<typeof useDraftLimits>;
  let limits: Limits;
  function LimitsProbe({ onRender, ...input }: DraftLimitsInput & { onRender(value: Limits): void }) {
    onRender(useDraftLimits(input));
    return null;
  }
  const render = (props: DraftLimitsInput) =>
    act(async () =>
      root.render(
        createElement(LimitsProbe, {
          ...props,
          onRender: (value) => {
            limits = value;
          },
        }),
      ),
    );
  const base: DraftLimitsInput = { text: "", readyDocs: [], vision: true, historyChars: 0, contextMax: null };

  it("a scanned PDF blocks a model that cannot see; figures only warn; unknown vision says nothing yet", async () => {
    const scanned = doc("scan.pdf", { kind: "pdf", meta: { pages: 1 }, scannedOnly: true, scannedPages: [1] });
    await render({ ...base, readyDocs: [scanned], vision: false });
    expect(limits.blocked).toBe(t("chat.docScannedBlock"));
    expect(limits.warnings).toEqual([]);
    await render({ ...base, readyDocs: [scanned], vision: null });
    expect(limits.blocked).toBeNull();
    const figures = doc("fig.pdf", { kind: "pdf", meta: { pages: 2 }, figureCount: 1, figurePages: [2] });
    await render({ ...base, readyDocs: [figures], vision: false });
    expect(limits.blocked).toBeNull();
    expect(limits.warnings).toEqual([t("chat.docFiguresWarn")]);
    await render({ ...base, readyDocs: [figures], vision: true });
    expect(limits.warnings).toEqual([]);
  });

  it("the whole conversation plus the draft must fit the model (documents named when they are the cause)", async () => {
    await render({ ...base, text: "x".repeat(100), contextMax: 8192 });
    expect(limits.blocked).toBeNull();
    expect(limits.plan.ok).toBe(true);
    await render({ ...base, text: "x".repeat(100), historyChars: 100_000, contextMax: 8192 });
    expect(limits.blocked).toBe(t("chat.tooLongChat"));
    const big = doc("big.txt", { text: "y".repeat(100_000) });
    await render({ ...base, readyDocs: [big], contextMax: 8192 });
    expect(limits.blocked).toBe(t("chat.tooLongDoc"));
    await render({ ...base, readyDocs: [big], contextMax: null });
    expect(limits.blocked).toBeNull();
  });
});
