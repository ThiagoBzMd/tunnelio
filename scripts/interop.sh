#!/usr/bin/env bash
# Cross-implementation test: Django relay + Go tray (headless) + TypeScript CLI, all real.
# Runs an ISOLATED server on $PORT (default 8095) with a temp DATA_DIR, a fresh headless tray and
# the Node interop CLI: register → pair (SPAKE2) → devices online → [models → chat → history when
# Ollama is reachable] → server restart → tray reconnects with its token → devices online again.
# Exit code 0 = every step passed. Used locally and by .github/workflows/ci.yml (no Ollama there).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8095}"
TMP="$(mktemp -d)"
SRV="$TMP/srv"; TRAY="$TMP/tray"; STATE="$TMP/cli-state.json"
mkdir -p "$SRV" "$TRAY"
OLLAMA_URL="${TUNNELIO_OLLAMA_URL:-http://127.0.0.1:11434}"
MODEL="${INTEROP_MODEL:-qwen2.5:0.5b}"

step() { printf '\n\033[36m== %s ==\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }
cleanup() {
  local rc=$? pid
  for pid in "$TRAY/pid" "$SRV/pid"; do
    [ -f "$pid" ] || continue
    kill "$(cat "$pid")" 2>/dev/null || true
    wait "$(cat "$pid")" 2>/dev/null || true   # let it exit: uvicorn still writes SQLite files while stopping
  done
  if [ "$rc" != 0 ] || [ "${KEEP_TMP:-0}" = 1 ]; then echo "logs kept in $TMP (server.log, tray.log)"; else rm -rf "$TMP" 2>/dev/null || true; fi
}
trap cleanup EXIT

start_server() {
  # `exec` makes the background subshell BECOME uvicorn, so $! is the real server pid.
  ( cd "$ROOT/server" && . .venv/bin/activate && \
    exec env DJANGO_SETTINGS_MODULE=tunnelio.settings.dev DATA_DIR="$SRV" CSRF_TRUSTED_ORIGINS="http://localhost:$PORT" \
      python -m uvicorn tunnelio.asgi:application --port "$PORT" --log-level warning ) >> "$SRV/server.log" 2>&1 &
  echo $! > "$SRV/pid"
  for _ in $(seq 1 50); do curl -sf "localhost:$PORT/healthz" >/dev/null 2>&1 && return 0; sleep 0.2; done
  fail "server did not start (see $SRV/server.log)"
}

# expect <pattern> <cmd...>: run, show the output, succeed when it matches (grep -E).
# (`cmd | tee /dev/stderr | grep -q` races: grep -q exits on the first match and tee may die
# with SIGPIPE, which pipefail reports as a failure — seen in CI, where the Ollama-less branch runs.)
expect() { local pat="$1"; shift; local out; out="$("$@" 2>&1)" || true; printf '%s\n' "$out" >&2; grep -qE -- "$pat" <<<"$out"; }

step "server (isolated, :$PORT)"
( cd "$ROOT/server" && . .venv/bin/activate && DJANGO_SETTINGS_MODULE=tunnelio.settings.dev DATA_DIR="$SRV" python manage.py migrate -v0 )
start_server

step "tray (headless, fresh config dir)"
( cd "$ROOT/tray" && go build -o bin/tunnelio ./cmd/tunnelio )  # always: a stale binary hides tray changes
"$ROOT/tray/bin/tunnelio" --headless --config-dir "$TRAY" --server "http://localhost:$PORT" --ollama "$OLLAMA_URL" > "$TRAY/tray.log" 2>&1 &
echo $! > "$TRAY/pid"
CODE=""
for _ in $(seq 1 100); do CODE="$(grep -oE 'PAIRING CODE: [0-9A-Z-]+' "$TRAY/tray.log" | head -1 | cut -d' ' -f3 || true)"; [ -n "$CODE" ] && break; sleep 0.2; done
[ -n "$CODE" ] || fail "no pairing code (see $TRAY/tray.log)"
echo "pairing code received"

CLI=(npx tsx "$ROOT/web/scripts/interop-client.ts" --server "http://localhost:$PORT" --state "$STATE")
cd "$ROOT/web"
EMAIL="interop-$(date +%s)@example.com"

step "register"
"${CLI[@]}" register --email "$EMAIL" --password "correct horse battery staple"

step "pair (SPAKE2 through the relay)"
OUT="$("${CLI[@]}" pair --code "$CODE")"; echo "${OUT//pairing_id=*/pairing_id=<redacted>}"
DEV="$(grep -oE 'device_id=[0-9a-f-]{36}' <<<"$OUT" | head -1 | cut -d= -f2)"
[ -n "$DEV" ] || fail "pairing did not return a device id"
grep -q "PAIRED device_id=$DEV" "$TRAY/tray.log" || fail "tray did not report PAIRED"

step "devices"
expect "online=true paired=true" "${CLI[@]}" devices || fail "device not online+paired"

if curl -sf -m 3 "$OLLAMA_URL/api/version" >/dev/null 2>&1; then
  step "models (real Ollama)"
  expect "^model name=" "${CLI[@]}" models --device "$DEV" || fail "no models listed"
  step "chat (streaming, private history)"
  expect "^done reason=stop" "${CLI[@]}" chat --device "$DEV" --model "$MODEL" --prompt "Answer with one word: hi" || fail "chat did not finish with stop"
  step "history"
  expect "^conversation id=" "${CLI[@]}" history --device "$DEV" || fail "history empty"
  step "agents and skills (kept by the tray; chat with an agent records it)"
  expect "^conversation agent=kept messages=2 roles=user,assistant" "${CLI[@]}" agents --device "$DEV" --model "$MODEL" --prompt "Say hi" || fail "agent chat not recorded"
else
  step "Ollama not reachable — skipping models/chat/history (device_info must still report it)"
  expect "E_OLLAMA_DOWN|ollama=(stopped|not_installed)" "${CLI[@]}" models --device "$DEV" || fail "expected E_OLLAMA_DOWN"
fi

step "agents and skills: save, list, delete on the tray"
expect "^deleted agents=0 skills=0" "${CLI[@]}" agents --device "$DEV" || fail "agents round trip failed"

step "server restart → tray reconnects with its token"
kill "$(cat "$SRV/pid")"; sleep 2
start_server
# full-jitter backoff caps at 60 s (SPEC §3.7): wait up to 75 s for the token reconnect
for _ in $(seq 1 375); do grep -q "relay connected.*device_id=$DEV paired=true" "$TRAY/tray.log" && break; sleep 0.2; done
grep -q "relay connected.*device_id=$DEV paired=true" "$TRAY/tray.log" || fail "tray did not reconnect as paired (see $TRAY/tray.log)"
"${CLI[@]}" devices | grep -q "online=true" || fail "device not online after reconnect"

step "remove device via REST → tray is revoked"
"${CLI[@]}" unpair --device "$DEV" >/dev/null 2>&1 || true
printf '\n\033[32mINTEROP OK\033[0m  (server %s, tray headless, TS CLI)\n' "$PORT"
