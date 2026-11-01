// Side-effect module: installs the pdf.js polyfills (see `ensurePdfjsPolyfills`). Imported first by
// the pdf.js worker wrapper so they exist inside the worker too.

import { ensurePdfjsPolyfills } from "./pdf";

ensurePdfjsPolyfills();
