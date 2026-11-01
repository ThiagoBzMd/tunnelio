- `tunnelio.desktop` — installed by the .deb (nfpm, `tray/.goreleaser.yaml`).
- `icons/hicolor/<size>/apps/tunnelio.png` — 16 to 512 px, generated from `brand/` by
  `node brand/generate-icons.mjs`; the .deb installs the 256 px one.
- Autostart on Linux: the app writes `~/.config/autostart/tunnelio.desktop` (opt-in, from the menu).
