package tray

import (
	"context"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/localui"
	"log/slog"
	"sync"
)

// Status is the snapshot rendered in the menu's status line.
type Status struct {
	Ollama        string // running | stopped | not_installed
	OllamaVersion string
	Relay         string // connected | connecting | offline
	Paired        bool
	Sessions      int
	ServerURL     string
	PairingCode   string // non-empty while a pairing is in progress
	UpdateVersion string // a newer release announced by the relay (empty: none)
}

// Actions are the callbacks behind the menu items. Every system action goes through here and
// only here (SPEC §8.5): nothing in the encrypted channel can reach them.
type Actions struct {
	Pair             func() error
	CancelPairing    func()
	StartOllama      func() error
	RestartOllama    func() error
	OpenDownloadPage func() error
	// OpenUpdatePage opens the download page of the newer release the relay announced.
	OpenUpdatePage   func() error
	AutostartEnabled func() bool
	SetAutostart     func(enable bool) error
	OpenConfigDir    func() error
	RemovePairings   func() error
	RemoveDevice     func() error
	CopyToClipboard  func(text string) error
	// ShowPairPage opens the local page with the QR code and instructions.
	ShowPairPage func() error
	// OpenSettings opens the local settings page.
	OpenSettings func() error
	Quit         func()
}

// Strings are the notification texts (bilingual, like Labels).
type Strings struct {
	Copied, PairedOK, PairFailed, CodeExpired string
	UpdateFmt                                 string // %s = the new version
}

var strings_ = map[localui.Lang]Strings{
	localui.LangEN: {Copied: "Pairing code copied to the clipboard.", PairedOK: "Device paired successfully.", PairFailed: "Pairing failed: ", CodeExpired: "The pairing code expired. Generate a new one when you are ready.",
		UpdateFmt: "Tunnelio %s is available. Download it from the menu."},
	localui.LangPTBR: {Copied: "Código de pareamento copiado.", PairedOK: "Dispositivo pareado com sucesso.", PairFailed: "O pareamento falhou: ", CodeExpired: "O código de pareamento expirou. Gere outro quando quiser.",
		UpdateFmt: "O Tunnelio %s está disponível. Baixe pelo menu."},
}

// StringsFor returns the notification strings for lang (English fallback).
func StringsFor(lang localui.Lang) Strings {
	if st, ok := strings_[lang]; ok {
		return st
	}
	return strings_[localui.LangEN]
}

// Notify is the notification sink used by the UI itself.
type Notify func(title, body string)

// UI drives the system tray. Create it with New, feed it with SetStatus/ShowPairingCode from any
// goroutine and call Run on the main goroutine.
type UI struct {
	log     *slog.Logger
	actions Actions
	notify  Notify
	labels  Labels
	strings Strings

	mu       sync.Mutex
	status   Status
	items    *menuItems // nil until the systray is ready (or in headless builds)
	started  bool
	quitting bool // set before the systray loop stops; menu updates are dropped from then on
}

// itemsForUpdate returns the menu items to render, or nil once the UI is quitting. On macOS every
// menu update is executed synchronously on the main thread, which stops when the tray quits:
// an update sent during shutdown (relay disconnect → status) would wait forever and the process
// would never exit — Quit "did nothing".
func (u *UI) itemsForUpdate() *menuItems {
	if u.quitting {
		return nil
	}
	return u.items
}

// Quitting marks the UI as shutting down; later SetStatus/ShowPairingCode calls are no-ops.
func (u *UI) Quitting() {
	u.mu.Lock()
	u.quitting = true
	u.mu.Unlock()
}

// New creates the UI.
func New(logger *slog.Logger, actions Actions, notify Notify) *UI {
	if logger == nil {
		logger = slog.Default()
	}
	if notify == nil {
		notify = func(string, string) {}
	}
	lang := localui.DetectLang()
	return &UI{log: logger, actions: actions, notify: notify, labels: LabelsFor(lang), strings: StringsFor(lang)}
}

// SetStatus updates the status line and item states.
func (u *UI) SetStatus(st Status) {
	u.mu.Lock()
	u.status = st
	items := u.itemsForUpdate()
	u.mu.Unlock()
	if items != nil {
		items.render(st)
	}
}

// ShowPairingCode displays the code in the menu and as a notification.
func (u *UI) ShowPairingCode(code string) {
	u.mu.Lock()
	u.status.PairingCode = code
	st := u.status
	items := u.itemsForUpdate()
	u.mu.Unlock()
	if items != nil {
		items.render(st)
	}
	u.notify("Pairing code", code+"\nEnter it in the browser within 5 minutes.")
}

// Run blocks until the tray quits or ctx is done. See ui_systray.go / ui_headless.go.
func (u *UI) Run(ctx context.Context) error { return u.run(ctx) }
