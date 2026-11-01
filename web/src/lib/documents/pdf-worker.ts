// pdf.js worker with the polyfills installed first (older Safari lacks what pdf.js 6 uses).
// Bundled by Vite as a module worker (`?worker`), loaded only when a PDF is attached.

import "./pdf-polyfills";
import "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
