# syntax=docker/dockerfile:1.7
# Build context: repository ROOT (needs web/ and server/).
#   docker build -f server/Dockerfile -t ghcr.io/thiagobzmd/tunnelio-server:dev .

# ── Stage 1: build the SPA ───────────────────────────────────────────────────
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
RUN npm run build            # → /web/dist

# ── Stage 2: Django + uvicorn ────────────────────────────────────────────────
FROM python:3.12-slim AS server
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    DJANGO_SETTINGS_MODULE=tunnelio.settings.prod \
    DATA_DIR=/data WEB_DIST_DIR=/app/web-dist STATIC_ROOT=/app/staticfiles PORT=8080
WORKDIR /app

RUN addgroup --system app && adduser --system --ingroup app app

# libpq for psycopg from Debian, like the rest of the system (its licence in /usr/share/doc), instead of
# the libraries a binary wheel would bundle.
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 && rm -rf /var/lib/apt/lists/*

COPY server/requirements/ requirements/
RUN pip install --no-cache-dir -r requirements/prod.txt

COPY server/ ./
COPY THIRD_PARTY_NOTICES.md ./
COPY --from=web /web/dist /app/web-dist
# The licences of the Python packages above, with their texts (the web app's are in web-dist).
RUN python scripts/third_party_licenses.py > /app/THIRD_PARTY_LICENSES-python.txt
RUN mkdir -p /data /app/staticfiles && chown -R app:app /data /app/staticfiles && chmod +x /app/entrypoint.sh

# Last, so a new commit only rebuilds this layer: the public commit this image comes from
# (GET /api/version, and /version.json next to the web app). The web bundle itself never contains
# it, so anyone can rebuild the bundle from that commit and compare it byte for byte.
ARG TUNNELIO_REVISION=development
ENV TUNNELIO_REVISION=${TUNNELIO_REVISION}
RUN printf '{"revision":"%s"}\n' "$TUNNELIO_REVISION" > /app/web-dist/version.json

USER app
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz').status==200 else 1)"
ENTRYPOINT ["/app/entrypoint.sh"]
