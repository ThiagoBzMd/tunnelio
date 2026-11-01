// Syntax highlighting for fenced code blocks: rehype-highlight (lowlight + the common highlight.js
// grammars). It is the heaviest piece of the chat path and most replies carry no code, so
// Markdown.tsx imports this module on demand, the first time a message has a fence; keeping it in
// its own file gives the lazy chunk a name of its own (`highlight-*.js`).

import type { Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";

export type RehypePlugins = NonNullable<Options["rehypePlugins"]>;

/** Only fences with a language are highlighted (no guessing; unknown languages stay plain). */
export const rehypePlugins: RehypePlugins = [[rehypeHighlight, { detect: false }]];
