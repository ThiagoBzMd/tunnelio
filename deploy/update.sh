#!/usr/bin/env bash
# Runs ON the production server, inside its clone of this repository, already checked out at the
# commit to deploy: back up the database, build the images here from this checkout, restart what
# changed, wait until it is healthy.
#
#   deploy/update.sh [all|server|nginx|site] [SITE_COMMIT]
#
# Needs deploy/.env.prod (git-ignored) next to this file; `.env` is a symlink to it. The site image
# is built from SITE_DIR (default ../../site/landing), a separate checkout of the site, which is not
# part of this repository; with SITE_COMMIT that checkout is first moved to that commit (a shallow
# fetch of it alone).
set -euo pipefail
cd "$(dirname "$0")"
WHAT="${1:-all}"
SITE_COMMIT="${2:-}"
case "$WHAT" in
  all) SERVICES=(tunnelio nginx site) ;;
  server) SERVICES=(tunnelio) ;;
  nginx) SERVICES=(nginx) ;;
  site) SERVICES=(site) ;;
  *) echo "usage: deploy/update.sh [all|server|nginx|site] [SITE_COMMIT]" >&2; exit 2 ;;
esac
[ -f .env.prod ] || { echo "update: deploy/.env.prod is missing" >&2; exit 1; }
[ -e .env ] || ln -s .env.prod .env
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "update: this checkout has local changes; production only builds what is on GitHub" >&2
  exit 1
fi
export TUNNELIO_REVISION TUNNELIO_REVISION_FULL SITE_REVISION
TUNNELIO_REVISION="$(git rev-parse --short HEAD)"
TUNNELIO_REVISION_FULL="$(git rev-parse HEAD)"   # baked into the images: /version.json, /api/version
SITE_REVISION="-"
if [[ " ${SERVICES[*]} " == *" site "* ]]; then
  SITE_REPO="${SITE_REPO:-$(cd ../.. && pwd)/site}"
  [ -d "$SITE_REPO/.git" ] || { echo "update: no site checkout at $SITE_REPO" >&2; exit 1; }
  if [ -n "$SITE_COMMIT" ]; then
    git -C "$SITE_REPO" fetch -q --depth 1 origin "$SITE_COMMIT"
    git -C "$SITE_REPO" checkout -q --detach FETCH_HEAD
  fi
  if [ -n "$(git -C "$SITE_REPO" status --porcelain --untracked-files=no)" ]; then
    echo "update: the site checkout has local changes; refusing" >&2
    exit 1
  fi
  SITE_REVISION="$(git -C "$SITE_REPO" rev-parse --short HEAD)"
fi
C=(docker compose -p deploy -f docker-compose.prod.yml)
BACKUPS="$(cd ../.. && pwd)/backups"
# age public keys (one per line); when present the dumps are encrypted to them, so this server
# writes dumps it cannot read (the private key stays with the operator). deploy/backup-db.sh too.
RECIPIENTS="$(cd ../.. && pwd)/backup-recipients.txt"
mkdir -p "$BACKUPS"
stamp="$(date +%Y%m%d-%H%M)"

# The site alone never touches the database: no backup then.
if [ "${SERVICES[*]}" = site ]; then
  echo "== site $SITE_REVISION: only the site container"
else
  echo "== $TUNNELIO_REVISION (site $SITE_REVISION): backup of the database"
  out="$BACKUPS/db-pre-deploy-$stamp.sql.gz"
  if [ -s "$RECIPIENTS" ]; then
    out="$out.age"
    "${C[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip | age -R "$RECIPIENTS" > "$out"
  else
    "${C[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$out"
  fi
  echo "backup $out"
fi

echo "== build: ${SERVICES[*]}"
LOGS="$(cd ../.. && pwd)/logs"
mkdir -p "$LOGS"
LOG="$LOGS/build-$stamp.log"
if ! "${C[@]}" build --pull "${SERVICES[@]}" > "$LOG" 2>&1; then
  tail -30 "$LOG" >&2
  echo "update: the build failed; nothing was restarted (log: $LOG)" >&2
  exit 1
fi
echo "built (log: $LOG)"

echo "== up"
"${C[@]}" up -d "${SERVICES[@]}" 2>&1 | tail -3
health() { docker inspect -f '{{.State.Health.Status}}' "deploy-$1-1" 2>/dev/null || echo none; }
for i in $(seq 1 60); do
  st="$(health tunnelio)" ng="$(health nginx)" si="$(health site)"
  [ "$st" = healthy ] && [ "$ng" = healthy ] && [ "$si" = healthy ] && break
  sleep 2
done
echo "tunnelio=$st nginx=$ng site=$si"
echo "$TUNNELIO_REVISION site=$SITE_REVISION $(date -Is) $WHAT" >> ../../DEPLOYED
"${C[@]}" ps --format '{{.Name}} {{.Status}}'
# Old images and build cache would fill the disk after a few deploys.
docker image prune -f >/dev/null
docker builder prune -f --filter until=168h >/dev/null
[ "$st" = healthy ] && [ "$ng" = healthy ] && [ "$si" = healthy ]
