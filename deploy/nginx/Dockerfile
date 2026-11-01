# Build context: repository ROOT (needs web/ and deploy/nginx/).
#   docker build -f deploy/nginx/Dockerfile -t ghcr.io/thiagobzmd/tunnelio-nginx:dev .

# ── Stage 1: the web app (static files) ─────────────────────────────────────
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
RUN npm run build            # → /web/dist

# ── Stage 2: nginx with the app and the proxy config ─────────────────────────
FROM nginx:alpine
RUN rm /etc/nginx/conf.d/default.conf
# Rendered at start by the image's envsubst hook (ADMIN_URL_PATH, RATE_LIMIT_KEY) into
# /etc/nginx/conf.d/; RATE_LIMIT_KEY comes from CLIENT_IP_HEADER (sourced just before).
COPY deploy/nginx/templates/ /etc/nginx/templates/
COPY deploy/nginx/16-rate-limit-key.envsh /docker-entrypoint.d/
RUN chmod 755 /docker-entrypoint.d/16-rate-limit-key.envsh
COPY deploy/nginx/proxy-headers.conf /etc/nginx/proxy-headers.conf
COPY deploy/nginx/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=web /web/dist /var/www/app/
# Last, so a new commit only rebuilds this layer: the public commit the app comes from. It lives
# next to the bundle, never inside it, so the bundle can be rebuilt from that commit and compared
# byte for byte (scripts/verify-build.sh).
ARG TUNNELIO_REVISION=development
RUN printf '{"revision":"%s"}\n' "$TUNNELIO_REVISION" > /var/www/app/version.json
