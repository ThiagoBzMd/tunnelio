import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import license from "rollup-plugin-license";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
const extraNotices = (file: string) => readFileSync(new URL(`./licenses/${file}`, import.meta.url), "utf8");

/**
 * dist/third-party-licenses.txt: every package in the bundle with its licence text (sorted, so the
 * build stays reproducible), then what the bundle carries that is not a package (fonts, style
 * sheets, copied and embedded code, data). The app links to it from Settings.
 */
const thirdPartyLicences = license({
  thirdParty: {
    includePrivate: false,
    output: {
      file: fileURLToPath(new URL("./dist/third-party-licenses.txt", import.meta.url)),
      template(deps) {
        const rule = "=".repeat(78);
        const entries = [...deps]
          .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
          .map((d) => {
            const repo = typeof d.repository === "string" ? d.repository : (d.repository?.url ?? d.homepage ?? "");
            const head = [`${d.name ?? "?"} ${d.version ?? ""}`.trim(), `Licence: ${d.license ?? "see below"}`, repo ? `Source: ${repo}` : ""].filter(Boolean).join("\n");
            return `${rule}\n${head}\n\n${(d.licenseText ?? "(the package ships no licence file)").trim()}\n${d.noticeText ? `\n${d.noticeText.trim()}\n` : ""}`;
          });
        return [
          "Tunnelio web app: third-party software in this bundle, with its licences.",
          "The app's own code is free software under the GNU AGPL-3.0-only: https://github.com/ThiagoBzMd/tunnelio",
          "",
          ...entries,
          rule,
          extraNotices("extra-notices.txt").trim(),
          rule,
          extraNotices("OFL-1.1.txt").trim(),
          "",
        ].join("\n");
      },
    },
  },
});

/** dist/LICENSE.txt: the app's own licence (web/LICENSE), which Settings → About links to. */
const licenceText: Plugin = {
  name: "tunnelio-licence-text",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "LICENSE.txt", source: readFileSync(new URL("./LICENSE", import.meta.url), "utf8") });
  },
};

// Dev: Vite on :5173 proxies /api and /ws to the Django server on :8080 (same-origin in prod).
export default defineConfig({
  plugins: [react(), tailwindcss(), licenceText],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // The document libraries are imported lazily (only when a file is attached). Pre-bundle them at
  // dev-server start: discovered on first use, Vite would re-optimise and reload the page mid-read.
  optimizeDeps: {
    include: ["pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/legacy/build/pdf.worker.min.mjs", "mammoth", "xlsx"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: false },
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      plugins: [thirdPartyLicences],
      output: {
        // Keep the heavy, rarely-changing bits in their own cacheable chunks.
        manualChunks: {
          react: ["react", "react-dom", "react-router"],
          crypto: ["@noble/curves", "@noble/hashes", "hash-wasm"],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts"],
  },
});
