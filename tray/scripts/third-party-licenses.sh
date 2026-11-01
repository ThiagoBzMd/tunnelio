#!/usr/bin/env bash
# Writes THIRD_PARTY_LICENSES.txt: the Go standard library and every module compiled into the
# computer app, for all the release targets, with their licence texts. The release configs run it
# before building and ship the file in every package (.zip, .deb, Tunnelio.app, MSIX).
#   scripts/third-party-licenses.sh [output]        (from tray/; default ./THIRD_PARTY_LICENSES.txt)
# Portable to the bash 3.2 of macOS runners.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-THIRD_PARTY_LICENSES.txt}"
RULE="=============================================================================="
SELF="$(go list -m)"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

for target in linux/amd64 linux/arm64 windows/amd64 windows/arm64 darwin/amd64 darwin/arm64; do
  os="${target%/*}"; arch="${target#*/}"; cgo=0
  [ "$os" = darwin ] && cgo=1
  GOOS="$os" GOARCH="$arch" CGO_ENABLED="$cgo" \
    go list -deps -f '{{with .Module}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}' ./cmd/tunnelio >> "$TMP"
done

{
  echo "Tunnelio computer app: third-party software compiled into it, with its licences."
  echo "The app's own code is free software under the GNU AGPL-3.0-only (LICENSE):"
  echo "https://github.com/ThiagoBzMd/tunnelio"
  echo
  echo "$RULE"
  echo "Go standard library and runtime $(go env GOVERSION)"
  echo "Licence: BSD-3-Clause, with Google's patent grant (PATENTS)"
  echo
  cat "$(go env GOROOT)/LICENSE"
  echo
  echo "--- PATENTS ---"
  cat "$(go env GOROOT)/PATENTS"
  sort -u "$TMP" | grep -v "^$SELF|" | grep -v '^$' | while IFS='|' read -r path version dir; do
    echo
    echo "$RULE"
    echo "$path $version"
    found=0
    for f in $(ls "$dir" | grep -i -E 'licen[cs]e|copying|notice|patents|unlicense' | sort); do
      [ -f "$dir/$f" ] || continue
      found=1
      echo
      echo "--- $f ---"
      cat "$dir/$f"
    done
    [ "$found" = 1 ] || echo "(the module ships no licence file)"
  done
} > "$OUT"
echo "wrote $OUT ($(grep -c "^$RULE" "$OUT") entries)"
