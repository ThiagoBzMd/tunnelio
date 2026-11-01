// Package assets embeds the tray icons. The files are placeholders generated programmatically
// (solid circle); the brand pipeline (brand/) replaces them with the real artwork. See README.md.
package assets

import _ "embed"

// IconPNG is the 64x64 tray icon used on Linux (and as the regular icon on macOS).
//
//go:embed icon.png
var IconPNG []byte

// IconICO is the Windows tray icon (PNG-compressed ICO, 16/32/48/256).
//
//go:embed icon.ico
var IconICO []byte

// IconTemplatePNG is the macOS template image (black + alpha, rendered by the menu bar).
//
//go:embed icon-template@2x.png
var IconTemplatePNG []byte
