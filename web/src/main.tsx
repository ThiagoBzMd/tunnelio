// Entry point: styles, runtime, React root. Routes live in app/router.tsx.

import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { InsecureContext, isSecureEnough } from "./app/InsecureContext";

// After a deploy the lazily loaded parts (document readers, settings…) get new file names; a tab
// opened before it would ask for files that no longer exist. Reload once to pick up the new version.
const RELOAD_KEY = "tunnelio:reloaded-for-update";
window.addEventListener("vite:preloadError", (event) => {
  try {
    if (sessionStorage.getItem(RELOAD_KEY)) return; // already tried: let the error surface
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});
window.addEventListener("load", () => {
  // A healthy load clears the guard after a while, so the next deploy can reload again.
  setTimeout(() => {
    try {
      sessionStorage.removeItem(RELOAD_KEY);
    } catch {
      /* storage unavailable */
    }
  }, 30_000);
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
// Without HTTPS (or localhost) the browser turns WebCrypto off and refuses the secure cookies:
// nothing would work, so say why instead of failing at the first click.
createRoot(root).render(<StrictMode>{isSecureEnough() ? <App /> : <InsecureContext />}</StrictMode>);
