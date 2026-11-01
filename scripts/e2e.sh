#!/usr/bin/env bash
# Visual end-to-end: Django server (:8080) + Vite (:5173, started by Playwright) + headless trays
# (started by the spec) + local Ollama. Screenshots land in web/e2e/screenshots/<project>/.
#   scripts/e2e.sh [playwright args…]      e.g. scripts/e2e.sh --project=desktop
# The server is (re)started by this script with e-mail to a directory (the spec reads the mailed
# codes from E2E_MAIL_DIR). The bot check is on when the environment gives its five BOT_CHECK_*
# variables (server/.env.example), e.g. the widget provider's test keys that always pass.
# A server already running from devserver.sh is stopped first and started again at the end.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export E2E_MAIL_DIR="${E2E_MAIL_DIR:-$(mktemp -d /tmp/tunnelio-e2e-mail-XXXXXX)}"
mkdir -p "$E2E_MAIL_DIR"
# (Read the PID file directly: piping `devserver.sh status` into grep -q trips pipefail.)
WAS_RUNNING=0
PIDFILE="$ROOT/server/data/server.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then WAS_RUNNING=1; fi
"$ROOT/scripts/devserver.sh" stop >/dev/null 2>&1 || true
sleep 1
if [ -n "${BOT_CHECK_SITE_KEY:-}" ] && [ -n "${BOT_CHECK_SECRET_KEY:-}" ] && [ -n "${BOT_CHECK_SCRIPT_URL:-}" ] \
  && [ -n "${BOT_CHECK_GLOBAL:-}" ] && [ -n "${BOT_CHECK_VERIFY_URL:-}" ]; then
  export BOT_CHECK_SITE_KEY BOT_CHECK_SECRET_KEY BOT_CHECK_SCRIPT_URL BOT_CHECK_GLOBAL BOT_CHECK_VERIFY_URL
  export E2E_BOT_CHECK=1   # the spec expects the widget
else
  unset BOT_CHECK_SITE_KEY BOT_CHECK_SECRET_KEY BOT_CHECK_SCRIPT_URL BOT_CHECK_GLOBAL BOT_CHECK_VERIFY_URL
  echo "e2e: no bot check (the five BOT_CHECK_* are not set)"
fi
EMAIL_URL="file://$E2E_MAIL_DIR" "$ROOT/scripts/devserver.sh" start
cleanup() {
  "$ROOT/scripts/devserver.sh" stop || true
  [ "$WAS_RUNNING" = 1 ] && "$ROOT/scripts/devserver.sh" start || true
}
trap cleanup EXIT
(cd "$ROOT/tray" && go build -o bin/tunnelio ./cmd/tunnelio)  # always: a stale binary hides tray changes
cd "$ROOT/web"
rm -rf e2e/screenshots
npx playwright test "$@"
echo
echo "screenshots: $ROOT/web/e2e/screenshots/"
ls e2e/screenshots/*/ 2>/dev/null | head -60
