#!/bin/sh
# Installs the Tunnelio computer app on Linux or macOS, for the current user, without sudo:
#   curl -fsSL https://raw.githubusercontent.com/ThiagoBzMd/tunnelio/main/scripts/install.sh | sh
# It downloads the latest release from GitHub (or the one in TUNNELIO_VERSION, e.g. v1.0.0),
# checks the file's SHA-256 against the release's checksum file, and then:
#   Linux  — unpacks the .deb into ~/.local (bin/tunnelio, the menu entry and the icon); nothing
#            touches the system. For a system-wide install use the .deb itself:
#            sudo apt install ./Tunnelio-ubuntu.deb
#   macOS  — copies Tunnelio.app from the .dmg into /Applications (or ~/Applications when
#            /Applications is not writable). The app is not signed yet: the first time, macOS asks
#            you to allow it in System Settings → Privacy & Security.
# Windows: download Tunnelio-windows.zip from the releases page, unzip it anywhere and run
# tunnelio.exe (Windows may warn about an unknown publisher).
set -eu

REPO="ThiagoBzMd/tunnelio"
VERSION="${TUNNELIO_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is needed and was not found"; }

need curl
if [ "$VERSION" = latest ]; then
  # The newest release of the computer app: tags vX.Y.Z. (The server image has its own releases,
  # server/vX.Y.Z, so GitHub's "latest" is not always the app's.)
  VERSION="$(curl -fsSL --proto '=https' "https://api.github.com/repos/$REPO/releases?per_page=30" \
    | grep -oE '"tag_name": *"v[0-9][0-9.]*"' | head -n 1 | sed 's/.*"\(v[^"]*\)"$/\1/')" || true
  [ -n "$VERSION" ] || die "could not find the latest release of the computer app"
fi
BASE="https://github.com/$REPO/releases/download/$VERSION"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

fetch() {  # url, file
  curl -fsSL --retry 3 --proto '=https' -o "$2" "$1" || die "could not download $1"
}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
verify() {  # file name, checksum file (lines "<sha256>  <name>")
  want="$(awk -v f="$1" '$2 == f { print $1 }' "$2" | head -n 1)"
  [ -n "$want" ] || die "$1 is not listed in the release's checksum file"
  got="$(sha256 "$TMP/$1")"
  [ "$got" = "$want" ] || die "SHA-256 mismatch for $1 (got $got, expected $want): not installed"
  say "  SHA-256 verified: $1"
}

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)
    case "$ARCH" in
      x86_64 | amd64)  FILE="Tunnelio-ubuntu.deb" ;;
      aarch64 | arm64) FILE="Tunnelio-ubuntu-arm64.deb" ;;
      *) die "no Linux build for $ARCH (there are amd64 and arm64)" ;;
    esac
    say "Downloading $FILE ($VERSION)…"
    fetch "$BASE/$FILE" "$TMP/$FILE"
    fetch "$BASE/checksums-ubuntu-windows.txt" "$TMP/sums.txt"
    verify "$FILE" "$TMP/sums.txt"

    # The .deb is an ar archive with data.tar.*; any of these tools opens it.
    mkdir -p "$TMP/pkg"
    if command -v dpkg-deb >/dev/null 2>&1; then
      dpkg-deb -x "$TMP/$FILE" "$TMP/pkg"
    elif command -v bsdtar >/dev/null 2>&1; then
      (cd "$TMP/pkg" && bsdtar -xf "$TMP/$FILE" --include='data.tar*' -O | bsdtar -xf -)
    elif command -v ar >/dev/null 2>&1; then
      (cd "$TMP" && ar x "$FILE" && tar -xf data.tar.* -C pkg)
    else
      die "none of dpkg-deb, bsdtar or ar is available to open the package"
    fi
    [ -x "$TMP/pkg/usr/bin/tunnelio" ] || die "the package has no usr/bin/tunnelio"

    PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}"
    BIN="$HOME/.local/bin"
    mkdir -p "$BIN" "$PREFIX/applications" "$PREFIX/icons/hicolor/256x256/apps" "$PREFIX/doc/tunnelio"
    install -m 755 "$TMP/pkg/usr/bin/tunnelio" "$BIN/tunnelio"
    install -m 644 "$TMP/pkg/usr/share/icons/hicolor/256x256/apps/tunnelio.png" "$PREFIX/icons/hicolor/256x256/apps/tunnelio.png"
    install -m 644 "$TMP/pkg/usr/share/doc/tunnelio/"* "$PREFIX/doc/tunnelio/"
    # The menu entry: the binary by its full path, since ~/.local/bin may not be on PATH yet.
    sed "s|^Exec=tunnelio|Exec=$BIN/tunnelio|" "$TMP/pkg/usr/share/applications/tunnelio.desktop" > "$PREFIX/applications/tunnelio.desktop"
    chmod 644 "$PREFIX/applications/tunnelio.desktop"
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$PREFIX/applications" 2>/dev/null || true

    say "Installed: $BIN/tunnelio ($("$BIN/tunnelio" --version 2>/dev/null || echo tunnelio))"
    say "Start it from the applications menu (Tunnelio) or run: $BIN/tunnelio"
    case ":${PATH:-}:" in *":$BIN:"*) ;; *) say "Note: $BIN is not on your PATH; add it to run 'tunnelio' from a terminal." ;; esac
    say "Then, in its tray menu, choose \"Pair a device…\" and follow https://tunnelio.app/docs"
    ;;

  Darwin)
    FILE="Tunnelio-macos.dmg"   # universal: Apple silicon and Intel
    need hdiutil
    say "Downloading $FILE ($VERSION)…"
    fetch "$BASE/$FILE" "$TMP/$FILE"
    fetch "$BASE/checksums-macos.txt" "$TMP/sums.txt"
    verify "$FILE" "$TMP/sums.txt"

    MNT="$TMP/dmg"
    mkdir -p "$MNT"
    hdiutil attach -nobrowse -quiet -mountpoint "$MNT" "$TMP/$FILE" || die "could not open the .dmg"
    APP="$(find "$MNT" -maxdepth 1 -name '*.app' | head -n 1)"
    [ -n "$APP" ] || { hdiutil detach -quiet "$MNT" || true; die "no .app inside the .dmg"; }
    if [ -w /Applications ]; then DEST="/Applications"; else DEST="$HOME/Applications"; mkdir -p "$DEST"; fi
    rm -rf "$DEST/Tunnelio.app"
    cp -R "$APP" "$DEST/Tunnelio.app"
    hdiutil detach -quiet "$MNT" || true

    say "Installed: $DEST/Tunnelio.app"
    say "The app is not signed yet: the first time, macOS asks you to allow it in"
    say "System Settings → Privacy & Security (or right-click the app → Open)."
    say "Then, in its menu-bar icon, choose \"Pair a device…\" and follow https://tunnelio.app/docs"
    ;;

  *)
    die "this script covers Linux and macOS; on Windows download Tunnelio-windows.zip from https://github.com/$REPO/releases/latest"
    ;;
esac
