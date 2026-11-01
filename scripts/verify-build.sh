#!/usr/bin/env bash
# Check that the web app served at a Tunnelio address is exactly the public code. The web app is
# what handles the password and the encryption, so this is the part worth checking: read the commit
# the address says it was built from (/version.json), rebuild the web app from that commit with the
# same container recipe production uses (deploy/nginx/Dockerfile, stage `web`), and compare every
# file byte for byte with what the address serves. Needs git, docker, curl, python3 and a clone of
# the public repository that contains the commit.
#
#   scripts/verify-build.sh                               # https://app.tunnelio.app
#   scripts/verify-build.sh https://tunnelio.example.org  # a self-hosted server
#   REVISION=<commit> scripts/verify-build.sh             # compare against another commit
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="${1:-https://app.tunnelio.app}"
URL="${URL%/}"
REV="${REVISION:-}"
if [ -z "$REV" ]; then
  REV="$(curl -fsS "$URL/version.json" | python3 -c 'import json, sys; print(json.load(sys.stdin)["revision"])')"
fi
echo "== $URL says it was built from $REV"
if ! git -C "$ROOT" cat-file -e "$REV^{commit}" 2>/dev/null && ! git -C "$ROOT" fetch -q origin "$REV" 2>/dev/null; then
  echo "commit $REV is not in this clone: run this script from an up-to-date clone of the public repository" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT
git -C "$ROOT" archive "$REV" web deploy/nginx | tar -x -C "$WORK"
echo "== rebuilding the web app from that commit (a minute or two)"
docker build -q --target web -f "$WORK/deploy/nginx/Dockerfile" -t tunnelio-verify-web "$WORK" >/dev/null
cid="$(docker create tunnelio-verify-web)"
docker cp -q "$cid:/web/dist" "$WORK/dist"
docker rm "$cid" >/dev/null

echo "== comparing every file with what $URL serves"
same=0
different=0
while IFS= read -r f; do
  ours="$(sha256sum "$WORK/dist/$f" | cut -c1-64)"
  theirs="$(curl -fsS "$URL/$f" | sha256sum | cut -c1-64)" || theirs=missing
  if [ "$ours" = "$theirs" ]; then
    same=$((same + 1))
  else
    different=$((different + 1))
    echo "DIFFERENT: $f"
  fi
done < <(cd "$WORK/dist" && find . -type f | sed 's#^\./##' | sort)
echo "files: $((same + different))  identical: $same  different: $different"
if [ "$different" -ne 0 ]; then
  echo "NOT VERIFIED: what $URL serves is not the public code at $REV" >&2
  exit 1
fi
echo "VERIFIED: the web app at $URL is exactly the public code at $REV"
