#!/usr/bin/env bash
# Dev helper: start/stop/status of the Django server (uvicorn) and a headless tray, with PID
# files, so that automated tests never need pkill. Logs go to server/data/.
#   scripts/devserver.sh start [port]      scripts/devserver.sh stop      scripts/devserver.sh status
#   scripts/devserver.sh tray-start <config-dir> [server-url]   scripts/devserver.sh tray-stop <config-dir>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$ROOT/server/data"; mkdir -p "$RUN"
PORT="${2:-8080}"

case "${1:-status}" in
  start)
    if [ -f "$RUN/server.pid" ] && kill -0 "$(cat "$RUN/server.pid")" 2>/dev/null; then echo "already running (pid $(cat "$RUN/server.pid"))"; exit 0; fi
    cd "$ROOT/server" && . .venv/bin/activate
    export DJANGO_SETTINGS_MODULE="${DJANGO_SETTINGS_MODULE:-tunnelio.settings.dev}"
    python manage.py migrate -v0
    nohup python -m uvicorn tunnelio.asgi:application --port "$PORT" --log-level "${LOG_LEVEL:-info}" > "$RUN/server.log" 2>&1 &
    echo $! > "$RUN/server.pid"
    for _ in $(seq 1 30); do curl -sf "localhost:$PORT/healthz" >/dev/null 2>&1 && { echo "server up on :$PORT (pid $(cat "$RUN/server.pid"))"; exit 0; }; sleep 0.3; done
    echo "server failed to start; see $RUN/server.log" >&2; exit 1 ;;
  stop)
    [ -f "$RUN/server.pid" ] && { kill "$(cat "$RUN/server.pid")" 2>/dev/null || true; rm -f "$RUN/server.pid"; echo "server stopped"; } || echo "not running" ;;
  status)
    [ -f "$RUN/server.pid" ] && kill -0 "$(cat "$RUN/server.pid")" 2>/dev/null && echo "server running (pid $(cat "$RUN/server.pid"))" || echo "server not running"
    curl -s -m 2 "localhost:$PORT/healthz" || true; echo ;;
  tray-start)
    CFG="${2:?config dir}"; SRV="${3:-http://localhost:8080}"; mkdir -p "$CFG"
    (cd "$ROOT/tray" && go build -o bin/tunnelio ./cmd/tunnelio)  # always: a stale binary hides tray changes
    nohup "$ROOT/tray/bin/tunnelio" --headless --config-dir "$CFG" --server "$SRV" > "$CFG/tray.log" 2>&1 &
    echo $! > "$CFG/tray.pid"; echo "tray started (pid $(cat "$CFG/tray.pid")), log $CFG/tray.log" ;;
  tray-stop)
    CFG="${2:?config dir}"; [ -f "$CFG/tray.pid" ] && { kill "$(cat "$CFG/tray.pid")" 2>/dev/null || true; rm -f "$CFG/tray.pid"; echo "tray stopped"; } || echo "tray not running" ;;
  *) echo "usage: $0 {start|stop|status|tray-start <dir> [url]|tray-stop <dir>}"; exit 1 ;;
esac
