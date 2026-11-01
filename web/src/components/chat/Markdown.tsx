// Assistant message rendering: GFM markdown, code blocks with a copy button, syntax highlighting
// loaded on demand (./highlight) the first time a message carries a fenced block. Until the module
// arrives the block renders unhighlighted in the same box; it re-renders highlighted when it does
// (only token spans are added, so nothing moves).

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useT } from "@/i18n";
import type { RehypePlugins } from "./highlight";

const remarkPlugins = [remarkGfm];
const NO_REHYPE: RehypePlugins = [];
/** A fence (``` or ~~~) at the start of a line, the only thing the highlighter acts on. */
const FENCE_RE = /^ {0,3}(?:`{3,}|~{3,})/m;

let highlighter: RehypePlugins | null = null;
let loading: Promise<RehypePlugins> | null = null;
function loadHighlighter(): Promise<RehypePlugins> {
  loading ??= import("./highlight").then((m) => (highlighter = m.rehypePlugins));
  return loading;
}

/** The highlighter once a fenced block asked for it and the module is here; nothing before that. */
function useHighlighter(wanted: boolean): RehypePlugins {
  const [plugins, setPlugins] = useState<RehypePlugins | null>(highlighter);
  useEffect(() => {
    if (!wanted || plugins) return;
    let active = true;
    // A chunk that vanished after a deploy is handled globally (vite:preloadError → one reload);
    // any other failure just leaves the block plain.
    loadHighlighter().then(
      (loaded) => {
        if (active) setPlugins(loaded);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [wanted, plugins]);
  return wanted && plugins ? plugins : NO_REHYPE;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useT();
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    const text = ref.current?.innerText ?? "";
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, []);
  return (
    <div className="group/code relative my-3">
      <button
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-md border bg-background/90 px-2 py-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100 hover:text-foreground"
        aria-label={t("chat.copyCode")}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        {copied ? t("common.copied") : t("common.copy")}
      </button>
      <pre ref={ref} className="overflow-x-auto rounded-lg border bg-muted/60 p-3 text-[13px] leading-relaxed">
        {children}
      </pre>
    </div>
  );
}

const components = { pre: CodeBlock };

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const rehypePlugins = useHighlighter(FENCE_RE.test(text));
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
