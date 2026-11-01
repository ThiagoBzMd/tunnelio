#!/usr/bin/env node
// Generates every icon of the project from the brand masters in this folder:
//   icon-light.svg  white square, black mark   (shown on dark backgrounds)
//   icon-dark.svg   dark square, white mark    (shown on light backgrounds; the default)
//   favicon.ico     16/32/48, supplied with the masters (dark variant), copied as is
// Rasterises with the Chromium that Playwright already installed for the web tests (no extra
// dependency): `node brand/generate-icons.mjs` from the repository root. Derived files are never
// edited by hand; change a master and run this again.

import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRAND = dirname(fileURLToPath(import.meta.url));
const ROOT = join(BRAND, "..");
const require = createRequire(join(ROOT, "web", "package.json"));
const { chromium } = require("playwright");

const light = readFileSync(join(BRAND, "icon-light.svg"), "utf8");
const dark = readFileSync(join(BRAND, "icon-dark.svg"), "utf8");

// ── pieces of the masters ─────────────────────────────────────────────────────
const LINES = [...light.matchAll(/<line [^>]*\/>/g)].map((m) => m[0]);
const ARCH = /<path d="([^"]+)"/.exec(light)?.[1];
const STROKE_WIDTH = /<g [^>]*stroke-width="(\d+)"/.exec(light)?.[1];
if (LINES.length === 0 || !ARCH || !STROKE_WIDTH) throw new Error("unexpected master SVG structure");
const GRADIENT = /<linearGradient[\s\S]*?<\/linearGradient>/.exec(dark)?.[0];
if (!GRADIENT) throw new Error("icon-dark.svg: gradient not found");

const SVG = (body, defs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;
const mark = (color, transform = "") =>
  `<g${transform ? ` transform="${transform}"` : ""}><g stroke="${color}" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" fill="none">${LINES.join("")}</g><path d="${ARCH}" fill="${color}"/></g>`;
const SAFE = "translate(512 512) scale(0.78) translate(-512 -512)"; // maskable: mark inside the 80 % circle
// Bounds of the mark (rays end at x 217–855, y 217–852, plus the round caps) with a thin margin.
const GLYPH_VIEWBOX = "170 168 732 732";
// Same mark centred in a box 1/0.85 larger: ~85 % of the slot (macOS menu bar).
const MENUBAR_VIEWBOX = "106 104 861 861";
const TRAY_STROKE = 60;
function glyph(color, strokeWidth, viewBox = GLYPH_VIEWBOX) {
  const body = `<g stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" fill="none">${LINES.join("")}</g><path d="${ARCH}" fill="${color}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="${viewBox}">${body}</svg>`;
}

const variants = {
  light,
  dark,
  // Full-bleed squares: platforms that round the corners themselves (iOS home screen, maskable).
  darkSquare: SVG(`<rect width="1024" height="1024" fill="url(#g)"/>${mark("#ffffff")}`, GRADIENT),
  darkMaskable: SVG(`<rect width="1024" height="1024" fill="url(#g)"/>${mark("#ffffff", SAFE)}`, GRADIENT),
  // macOS template image: the mark only, black + alpha (the menu bar recolours it). The mark
  // fills ~85 % of the 22 pt slot, the size of Apple's own menu-bar glyphs (the full square with
  // its margins looked small next to them).
  template: glyph("#000000", STROKE_WIDTH, MENUBAR_VIEWBOX),
  // Linux top bar (GNOME/Ubuntu panels are dark): the mark only, white, cropped to its own bounds
  // so it is as big as the neighbouring status icons. Slightly heavier strokes stay legible at
  // the 16–24 px the panel draws.
  trayGlyph: glyph("#ffffff", TRAY_STROKE),
};

// Adaptive SVG for browser tabs: dark icon on light UIs, light icon on dark UIs.
const adaptive = SVG(
  `<rect class="bg" width="1024" height="1024" rx="230"/><g class="fg" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" fill="none">${LINES.join("")}</g><path class="fgf" d="${ARCH}"/>`,
  `${GRADIENT}<style>.bg{fill:url(#g)}.fg{stroke:#fff}.fgf{fill:#fff}@media (prefers-color-scheme:dark){.bg{fill:#fff}.fg{stroke:#000}.fgf{fill:#000}}</style>`,
);

// ── rasteriser ────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function png(svg, size) {
  const sized = svg.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${sized}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

/** Raw RGBA pixels of an SVG at `size` (straight alpha), via a canvas in the page. */
async function rgba(svg, size) {
  const sized = svg.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`);
  await page.setViewportSize({ width: size, height: size });
  const data = await page.evaluate(async ({ svg, size }) => {
    const img = new Image();
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
    await img.decode();
    const c = document.createElement("canvas");
    c.width = size; c.height = size;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0, size, size);
    return Array.from(g.getImageData(0, 0, size, size).data);
  }, { svg: sized, size });
  return Uint8Array.from(data);
}

/** One classic ICO entry: 32-bit BGRA DIB (bottom-up) + 1-bit AND mask. What LoadImage expects. */
function dib(pixels, size) {
  const rowMask = Math.ceil(size / 32) * 4; // mask rows are padded to 4 bytes
  const out = Buffer.alloc(40 + size * size * 4 + rowMask * size);
  out.writeUInt32LE(40, 0);          // biSize
  out.writeInt32LE(size, 4);         // biWidth
  out.writeInt32LE(size * 2, 8);     // biHeight: XOR + AND
  out.writeUInt16LE(1, 12);          // biPlanes
  out.writeUInt16LE(32, 14);         // biBitCount
  out.writeUInt32LE(0, 16);          // BI_RGB
  out.writeUInt32LE(size * size * 4 + rowMask * size, 20);
  let o = 40;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      out[o++] = pixels[i + 2]; out[o++] = pixels[i + 1]; out[o++] = pixels[i]; out[o++] = pixels[i + 3];
    }
  }
  for (let y = size - 1; y >= 0; y--) {
    const row = Buffer.alloc(rowMask);
    for (let x = 0; x < size; x++) if (pixels[(y * size + x) * 4 + 3] === 0) row[x >> 3] |= 0x80 >> (x & 7);
    row.copy(out, o); o += rowMask;
  }
  return out;
}

// ── containers ────────────────────────────────────────────────────────────────
/** ICO: entries are {size, data, bmp?}; PNG entries only for 256 (Vista+), DIB for the rest. */
function ico(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, data }, i) => {
    const o = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, o);
    header.writeUInt8(size >= 256 ? 0 : size, o + 1);
    header.writeUInt16LE(1, o + 4);
    header.writeUInt16LE(32, o + 6);
    header.writeUInt32LE(data.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.data)]);
}

/** ICNS with PNG entries (macOS 10.7+). */
function icns(entries) {
  const chunks = entries.map(({ type, data }) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, "ascii");
    h.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([h, data]);
  });
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const h = Buffer.alloc(8);
  h.write("icns", 0, "ascii");
  h.writeUInt32BE(total, 4);
  return Buffer.concat([h, ...chunks]);
}

const out = (rel, data) => {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  console.log(`  ${rel} (${data.length} B)`);
};

// ── targets ───────────────────────────────────────────────────────────────────
console.log("tray");
out("tray/assets/icon.png", await png(variants.trayGlyph, 64)); // Linux StatusNotifier: white glyph, transparent
out("tray/assets/icon-template@2x.png", await png(variants.template, 44)); // macOS menu bar
{
  const entries = [];
  for (const size of [16, 24, 32, 48]) entries.push({ size, data: dib(await rgba(variants.dark, size), size) });
  entries.push({ size: 256, data: await png(variants.dark, 256) });
  out("tray/assets/icon.ico", ico(entries));
}
for (const size of [16, 32, 48, 64, 128, 256, 512]) out(`tray/packaging/linux/icons/hicolor/${size}x${size}/apps/tunnelio.png`, await png(variants.dark, size));
out(
  "tray/packaging/macos/AppIcon.icns",
  icns([
    { type: "ic11", data: await png(variants.dark, 32) },
    { type: "ic12", data: await png(variants.dark, 64) },
    { type: "ic07", data: await png(variants.dark, 128) },
    { type: "ic13", data: await png(variants.dark, 256) },
    { type: "ic08", data: await png(variants.dark, 256) },
    { type: "ic14", data: await png(variants.dark, 512) },
    { type: "ic09", data: await png(variants.dark, 512) },
    { type: "ic10", data: await png(variants.dark, 1024) },
  ]),
);

// Microsoft Store / MSIX assets (tray/packaging/windows/Assets): full-bleed squares, the Store
// adds its own corner radius. Square44x44 is the taskbar/Start tile, Square150x150 the medium
// tile, StoreLogo the listing.
for (const [name, size] of [["Square44x44Logo", 44], ["Square150x150Logo", 150], ["StoreLogo", 50]]) {
  out(`tray/packaging/windows/Assets/${name}.png`, await png(variants.darkSquare, size));
}

console.log("web (app.tunnelio.app)");
out("web/public/icon.svg", Buffer.from(adaptive));
copyFileSync(join(BRAND, "favicon.ico"), join(ROOT, "web/public/favicon.ico"));
console.log("  web/public/favicon.ico (copied)");
out("web/public/apple-touch-icon.png", await png(variants.darkSquare, 180));
out("web/public/icon-192.png", await png(variants.dark, 192));
out("web/public/icon-512.png", await png(variants.dark, 512));
out("web/public/icon-maskable-512.png", await png(variants.darkMaskable, 512));
rmSync(join(ROOT, "web/public/icon-maskable.svg"), { force: true });

// The public site's folder (landing/) is not part of every checkout; skip it when absent.
if (existsSync(join(ROOT, "landing"))) {
  console.log("landing (tunnelio.app)");
  out("landing/public/assets/icon.svg", Buffer.from(adaptive));
  copyFileSync(join(BRAND, "favicon.ico"), join(ROOT, "landing/public/favicon.ico"));
  console.log("  landing/public/favicon.ico (copied)");
  out("landing/public/assets/apple-touch-icon.png", await png(variants.darkSquare, 180));
  out("landing/public/assets/icon-512.png", await png(variants.dark, 512));
}

await browser.close();
