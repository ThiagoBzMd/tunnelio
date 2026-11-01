#!/usr/bin/env bash
# Wraps the universal binary into Tunnelio.app, signs, notarizes and builds the DMG.
# Called by GoReleaser (.goreleaser.darwin.yaml) as: build-app.sh <path-to-binary> <version>
# Signing/notarization only run when the APPLE_* secrets are present; otherwise the app is
# left unsigned (fine for local testing; Gatekeeper will complain).
set -euo pipefail
BIN="$1"; VERSION="$2"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(dirname "$BIN")"
APP="$OUT/Tunnelio.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/tunnelio"
sed "s/VERSION/$VERSION/g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
[ -f "$HERE/AppIcon.icns" ] && cp "$HERE/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
# The licence and the third-party licences (scripts/third-party-licenses.sh, run before the build).
cp "$HERE/../../LICENSE" "$APP/Contents/Resources/LICENSE.txt"
cp "$HERE/../../THIRD_PARTY_LICENSES.txt" "$APP/Contents/Resources/THIRD_PARTY_LICENSES.txt"

if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --entitlements "$HERE/entitlements.plist" \
    --sign "$APPLE_SIGNING_IDENTITY" "$APP"
fi

DMG="$OUT/Tunnelio-macos.dmg"   # version-less: releases/latest/download/Tunnelio-macos.dmg
rm -f "$DMG"
hdiutil create -volname "Tunnelio" -srcfolder "$APP" -ov -format UDZO "$DMG"

if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  xcrun stapler staple "$DMG"
fi
echo "built $DMG"
