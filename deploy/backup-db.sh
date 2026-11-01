#!/usr/bin/env bash
# A daily dump of the production database (docker-compose.prod.yml), run on the server from this
# folder by a timer. Compressed and, when ../../backup-recipients.txt holds age public keys,
# encrypted to them: the server writes dumps it cannot read; whoever holds the private key restores
#   age -d -i KEY db-daily-<stamp>.sql.gz.age | gunzip | docker compose … exec -T db psql …
# Keeps the newest $BACKUP_KEEP daily dumps (default 30) in ../../backups, next to the ones
# deploy/update.sh makes before each deploy.
set -euo pipefail
cd "$(dirname "$0")"
BACKUPS="$(cd ../.. && pwd)/backups"
RECIPIENTS="$(cd ../.. && pwd)/backup-recipients.txt"
KEEP="${BACKUP_KEEP:-30}"
C=(docker compose -p deploy -f docker-compose.prod.yml)
mkdir -p "$BACKUPS"

out="$BACKUPS/db-daily-$(date +%Y%m%d-%H%M).sql.gz"
[ -s "$RECIPIENTS" ] && out="$out.age"
trap 'rm -f "$out.part"' EXIT
if [ -s "$RECIPIENTS" ]; then
  "${C[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip | age -R "$RECIPIENTS" > "$out.part"
else
  "${C[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$out.part"
fi
mv "$out.part" "$out"
echo "backup $out ($(stat -c %s "$out") bytes)"

# Only the newest $KEEP daily dumps stay.
find "$BACKUPS" -maxdepth 1 -name 'db-daily-*' -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2- | xargs -r rm -f --
