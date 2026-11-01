module github.com/ThiagoBzMd/tunnelio/tray

go 1.26.0

// Direct dependencies (SPEC §14.9):
//   fyne.io/systray                 tray icon/menu (CGO only on macOS; excluded with -tags headless)
//   github.com/gen2brain/beeep      local notifications
//   github.com/coder/websocket      WebSocket client (pure Go)
//   filippo.io/nistec               P-256 point arithmetic for SPAKE2 (RFC 9382)
//   golang.org/x/crypto             hkdf
//   modernc.org/sqlite              SQLite without CGO (private history); requires go >= 1.26
//   golang.org/x/sys                Windows registry (autostart) and process flags
// Everything else is transitive (systray → dbus; beeep → toast/notify; sqlite → modernc libc).

require (
	filippo.io/nistec v0.0.4
	fyne.io/systray v1.12.2
	github.com/atotto/clipboard v0.1.4
	github.com/coder/websocket v1.8.15
	github.com/gen2brain/beeep v0.11.2
	github.com/jezek/xgb v1.3.1
	github.com/skip2/go-qrcode v0.0.0-20200617195104-da1b6568686e
	golang.org/x/crypto v0.57.0
	golang.org/x/sys v0.48.0
	modernc.org/sqlite v1.60.1
)

require (
	git.sr.ht/~jackmordaunt/go-toast v1.1.2 // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/esiqveland/notify v0.13.3 // indirect
	github.com/go-ole/go-ole v1.3.0 // indirect
	github.com/godbus/dbus/v5 v5.1.0 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/jackmordaunt/icns/v3 v3.0.1 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/nfnt/resize v0.0.0-20180221191011-83c6a9932646 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/sergeymakinen/go-bmp v1.0.0 // indirect
	github.com/sergeymakinen/go-ico v1.0.0-beta.0 // indirect
	github.com/tadvi/systray v0.0.0-20190226123456-11a2b8fa57af // indirect
	modernc.org/libc v1.77.1 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.12.1 // indirect
)
