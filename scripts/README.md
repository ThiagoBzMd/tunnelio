# scripts/

| Script | Purpose |
|---|---|
| `devserver.sh start\|stop\|status` · `tray-start <dir> [url]` · `tray-stop <dir>` | development server (:8080) and headless tray with PID files (never `pkill -f`) |
| `interop.sh` | pairing + real Go ⇄ TS session: isolated server (:8095) + headless tray + CLI `web/scripts/interop-client.ts` (SPEC §13); with a local Ollama, also models, chat, history and an agent with a skill |
| `check.sh [--dir CHECKOUT] [PART…]` | the CI workflow's parts on this machine: `vectors`, `server`, `web`, `tray`, `interop`, `site` (no part = all); `--dir` runs them on another checkout, e.g. a clean worktree of one commit |
| `e2e.sh` | Playwright (desktop + mobile) against the devserver; screenshots in `web/e2e/screenshots/` |
| `verify-build.sh [URL]` | rebuilds the web app from the public commit a Tunnelio address says it runs (`/version.json`) and compares every file byte for byte with what it serves (README, "Verifying what tunnelio.app runs") |

`devserver.sh`, `interop.sh` and `e2e.sh` **always rebuild** the tray (`tray/bin/tunnelio`, seconds
with the Go cache), so a stale binary never hides a tray change.
