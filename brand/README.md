# brand/ — visual identity (single source)

The **masters** live here and everything else is generated. Nothing is edited by hand in the derived files: if a
master changes, run the generator again.

| Master | What it is |
|---|---|
| `icon-dark.svg` | dark square (gradient), white symbol. **Default variant**: goes on light backgrounds. |
| `icon-light.svg` | white square, black symbol. Goes on dark backgrounds. |
| `favicon.ico` | 16/32/48 px of the dark variant, supplied together with the SVGs; copied as is. |

```sh
node brand/generate-icons.mjs     # from the repository root; uses Playwright's Chromium (web/)
```

| Generated | Size | Use |
|---|---|---|
| `tray/assets/icon.png` | 64 | Linux tray: **symbol only, white, transparent background**, tightly cropped and with a slightly thicker stroke, so it matches the size and weight of the other panel icons (GNOME/Ubuntu panels are dark) |
| `tray/assets/icon.ico` | 16/32/48/256 | Windows tray (and installer) |
| `tray/assets/icon-template@2x.png` | 44 | macOS menu bar (*template image*: symbol only, black + alpha) |
| `tray/packaging/linux/icons/hicolor/*/apps/tunnelio.png` | 16–512 | `.desktop` (the `.deb`) |
| `tray/packaging/macos/AppIcon.icns` | 32–1024 | `.app` bundle (`CFBundleIconFile`) |
| `tray/packaging/windows/Assets/*.png` | 44/150/50 | MSIX / Microsoft Store (tile, medium tile, listing) |
| `web/public/icon.svg`, `landing/public/assets/icon.svg`¹ | vector | browser tab; **adaptive**: dark on a light theme, light on a dark theme |
| `web/public/favicon.ico`, `landing/public/favicon.ico`¹ | 16/32/48 | old browsers |
| `web/public/apple-touch-icon.png`, `landing/public/assets/apple-touch-icon.png`¹ | 180 | iPhone home screen (full square; iOS rounds the corners) |
| `web/public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | — | PWA (`manifest.webmanifest`); the *maskable* one has the symbol inside the safe zone |
| `landing/public/assets/icon-512.png`¹ | 512 | sharing |

¹ Only when the site's folder (`landing/`) is present; the generator skips it otherwise.

The symbol also appears **inline** (same geometry, theme colors) in
`web/src/components/layout/Logo.tsx`, in the landing header and in the tray's local pages
(`tray/internal/localui/template.go`). If the geometry changes, update these three as well.
