// @vitest-environment jsdom
// Assistant markdown rendered for real (React + jsdom): GFM works without the highlighter, a fenced
// block shows its text at once and gains highlight.js spans once the lazily loaded module arrives
// (same <pre>, same text), and a fence with an unknown language stays plain instead of failing.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Markdown } from "../src/components/chat/Markdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const render = (text: string) => act(async () => root.render(createElement(Markdown, { text })));

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}; DOM: ${host.innerHTML}`);
}

describe("Markdown", () => {
  it("renders GFM without touching the highlighter", async () => {
    await render("Hello **world**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done");
    expect(host.querySelector("strong")?.textContent).toBe("world");
    expect(host.querySelector("table td")?.textContent).toBe("1");
    expect(host.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(host.querySelector("[class*='hljs']")).toBeNull();
  });

  it("a fenced block keeps its text and gains highlighting when the module arrives", async () => {
    await render("Code:\n\n```js\nconst a = 1;\n```\n");
    expect(host.querySelector("pre")?.textContent).toBe("const a = 1;\n");
    await waitFor(() => host.querySelector(".hljs-keyword") !== null, "the highlighter");
    expect(host.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(host.querySelector("pre code")?.className).toContain("hljs");
    expect(host.querySelector("pre")?.textContent).toBe("const a = 1;\n");
    expect(host.querySelectorAll("pre")).toHaveLength(1);
  });

  it("a fence with an unknown language stays plain", async () => {
    await render("```nosuchlanguage\nx = 1\n```\n");
    await waitFor(() => host.querySelector("pre code") !== null, "the code block");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(host.querySelector("pre")?.textContent).toBe("x = 1\n");
    expect(host.querySelector("[class*='hljs-']")).toBeNull();
  });
});
