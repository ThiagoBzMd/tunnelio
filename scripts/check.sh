#!/usr/bin/env bash
# The tests, run on this machine: what GitHub's CI workflow runs, part by part.
#   scripts/check.sh [--dir CHECKOUT] [PART…]      no PART = all of them
# Parts: vectors (the protocol vectors are reproducible), server (ruff, pytest), web (eslint, tsc,
# vitest, build), tray (go test, golangci-lint), interop (scripts/interop.sh: Django relay + Go tray
# + TS CLI, real processes), site (landing/, when the checkout has it: lint, types, static export).
# --dir runs them on another checkout of this repository (e.g. a clean worktree of one commit); its
# server/.venv may be a link to this one's. Exit code 0 = every part passed.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$HERE"
if [ "${1:-}" = --dir ]; then
  DIR="$(cd "$2" && pwd)"
  shift 2
fi
PARTS=("$@")
[ ${#PARTS[@]} -gt 0 ] || PARTS=(vectors server web tray interop site)
# Go comes from PATH; the tools installed with `go install` (golangci-lint) live in its GOPATH/bin.
if command -v go >/dev/null; then export PATH="$(go env GOPATH)/bin:$PATH"; fi

step() { printf '\n== check: %s (%s)\n' "$1" "$DIR"; }
web_deps() { [ -d "$DIR/web/node_modules" ] || (cd "$DIR/web" && npm ci --no-audit --no-fund >/dev/null); }

for part in "${PARTS[@]}"; do
  case "$part" in
    vectors)
      step "protocol vectors are reproducible"
      (cd "$DIR/docs/vectors" && "$DIR/server/.venv/bin/python" gen_vectors.py >/dev/null)
      git -C "$DIR" diff --exit-code -- docs/vectors/vectors.json
      ;;
    server)
      step "server"
      (cd "$DIR/server" && .venv/bin/ruff check . && .venv/bin/ruff format --check . >/dev/null && .venv/bin/python -m pytest -q)
      ;;
    web)
      step "web"
      web_deps
      (cd "$DIR/web" && npm run -s lint && npx tsc --noEmit && npm test -- --run && npm run -s build >/dev/null)
      ;;
    tray)
      step "tray"
      (cd "$DIR/tray" && go test ./... && golangci-lint run ./...)
      ;;
    interop)
      step "interop"
      web_deps
      "$DIR/scripts/interop.sh"
      ;;
    site)
      if [ ! -d "$DIR/landing" ]; then
        echo "check: no landing/ in this checkout; skipping the site"
        continue
      fi
      step "site"
      (cd "$DIR/landing" && npm ci --no-audit --no-fund >/dev/null && npm run -s lint && npm run -s typecheck && NEXT_TELEMETRY_DISABLED=1 npm run -s build)
      ;;
    *)
      echo "check: unknown part '$part' (vectors, server, web, tray, interop, site)" >&2
      exit 2
      ;;
  esac
done
printf '\n== check: passed (%s)\n' "${PARTS[*]}"
