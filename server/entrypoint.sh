#!/bin/sh
# One container, one port, one volume (/data). Migrations run on every start (like Open WebUI).
set -e

mkdir -p "${DATA_DIR:-/data}"
python manage.py migrate --noinput
python manage.py collectstatic --noinput >/dev/null

WORKERS="${UVICORN_WORKERS:-1}"
if [ "$WORKERS" -gt 1 ] && [ -z "${REDIS_URL:-}" ]; then
  echo "ERROR: UVICORN_WORKERS=$WORKERS requires REDIS_URL (InMemoryChannelLayer is single-process)." >&2
  exit 1
fi

# Daily purge of relay metadata past retention (SPEC §11.1); idempotent, safe with 1 worker.
( while true; do sleep 86400; python manage.py purge_relay_logs || true; done ) &
# Daily refresh of the public Ollama model list (served at /api/catalog/ollama); the bundled
# snapshot answers until the first fetch lands, and a failed fetch keeps the previous list.
( while true; do python manage.py refresh_ollama_catalog || true; sleep 86400; done ) &

# X-Forwarded-For and -Proto are trusted only from the addresses in FORWARDED_ALLOW_IPS (uvicorn's
# variable; by default only loopback): from anyone else, the visitor could write their own address
# there. Behind a proxy, the visitor's address comes from CLIENT_IP_HEADER (tunnelio/middleware.py).
exec python -m uvicorn tunnelio.asgi:application \
  --host 0.0.0.0 --port "${PORT:-8080}" --workers "$WORKERS" \
  --proxy-headers \
  --ws-max-size "${RELAY_MAX_FRAME_BYTES:-8388608}" \
  --log-level "$(echo "${LOG_LEVEL:-info}" | tr '[:upper:]' '[:lower:]')"
