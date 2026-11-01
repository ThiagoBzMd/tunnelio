//go:build !headless

package tray

import (
	"context"
	"fmt"
	"runtime"

	"fyne.io/systray"

	"github.com/ThiagoBzMd/tunnelio/tray/assets"
)

// menuItems holds the systray handles (only in builds with the systray). Every item is
// top-level: on Linux (AppIndicator/dbusmenu) an item that owns sub-items becomes a submenu
// parent and its own click never fires.
type menuItems struct {
	l          Labels
	status     *systray.MenuItem
	update     *systray.MenuItem
	pair       *systray.MenuItem
	code       *systray.MenuItem
	showPage   *systray.MenuItem
	cancelPair *systray.MenuItem
	ollama     *systray.MenuItem
	download   *systray.MenuItem
	settings   *systray.MenuItem
	autostart  *systray.MenuItem
	removePair *systray.MenuItem
	removeDev  *systray.MenuItem
	quit       *systray.MenuItem
}

func (u *UI) run(ctx context.Context) error {
	u.mu.Lock()
	if u.started {
		u.mu.Unlock()
		return fmt.Errorf("tray: already running")
	}
	u.started = true
	u.mu.Unlock()
	onReady := func() {
		if runtime.GOOS == "windows" {
			systray.SetIcon(assets.IconICO)
		} else {
			systray.SetTemplateIcon(assets.IconTemplatePNG, assets.IconPNG)
		}
		systray.SetTooltip(AppName)
		items := u.buildMenu()
		u.mu.Lock()
		u.items = items
		st := u.status
		u.mu.Unlock()
		items.render(st)
		go u.loop(ctx, items)
	}
	onExit := func() {}
	// Returns when systray.Quit is called (by the Quit item or by ctx).
	systray.Run(onReady, onExit)
	return nil
}

func (u *UI) buildMenu() *menuItems {
	l := u.labels
	m := &menuItems{l: l}
	m.status = systray.AddMenuItem(l.Starting, "")
	m.status.Disable()
	m.update = systray.AddMenuItem("", "")
	m.update.Hide()
	systray.AddSeparator()
	m.pair = systray.AddMenuItem(l.Pair, "")
	m.code = systray.AddMenuItem("", "")
	m.code.Disable()
	m.code.Hide()
	m.showPage = systray.AddMenuItem(l.ShowPage, "")
	m.showPage.Hide()
	m.cancelPair = systray.AddMenuItem(l.CancelPair, "")
	m.cancelPair.Hide()
	systray.AddSeparator()
	m.ollama = systray.AddMenuItem(l.StartOllama, "")
	m.download = systray.AddMenuItem(l.DownloadOllama, "")
	systray.AddSeparator()
	m.settings = systray.AddMenuItem(l.Settings, "")
	enabled := u.actions.AutostartEnabled != nil && u.actions.AutostartEnabled()
	m.autostart = systray.AddMenuItemCheckbox(l.Autostart, "", enabled)
	systray.AddSeparator()
	m.removePair = systray.AddMenuItem(l.ForgetBrowsers, "")
	m.removeDev = systray.AddMenuItem(l.UnlinkDevice, "")
	systray.AddSeparator()
	m.quit = systray.AddMenuItem(l.Quit, "")
	return m
}

func (m *menuItems) render(st Status) {
	l := m.l
	var relay string
	switch st.Relay {
	case "connected":
		if st.Paired {
			relay = fmt.Sprintf("%s · %s · "+l.Sessions, l.RelayConnected, l.Paired, st.Sessions)
		} else {
			relay = l.RelayConnected + " · " + l.NotPaired
		}
	case "connecting":
		relay = l.RelayConnecting
	default:
		relay = l.RelayOffline
	}
	var ollama string
	switch st.Ollama {
	case "running":
		ollama = fmt.Sprintf(l.OllamaRunning, st.OllamaVersion)
		m.ollama.SetTitle(l.RestartOllama)
		m.ollama.Enable()
	case "stopped":
		ollama = l.OllamaStopped
		m.ollama.SetTitle(l.StartOllama)
		m.ollama.Enable()
	default:
		ollama = l.OllamaMissing
		m.ollama.SetTitle(l.OllamaNotInstalled)
		m.ollama.Disable()
	}
	m.status.SetTitle(fmt.Sprintf(l.StatusFmt, ollama, relay))
	if st.UpdateVersion != "" {
		m.update.SetTitle(fmt.Sprintf(l.UpdateFmt, st.UpdateVersion))
		m.update.Show()
	} else {
		m.update.Hide()
	}
	if st.PairingCode != "" {
		m.code.SetTitle(fmt.Sprintf(l.CodeFmt, st.PairingCode))
		m.code.Enable()
		m.code.Show()
		m.showPage.Show()
		m.cancelPair.Show()
	} else {
		m.code.Disable()
		m.code.Hide()
		m.showPage.Hide()
		m.cancelPair.Hide()
	}
	if st.Relay == "connected" {
		m.pair.Enable()
	} else {
		m.pair.Disable()
	}
	if st.Paired {
		m.removeDev.Enable()
	} else {
		m.removeDev.Disable()
	}
}

// loop dispatches clicks to the actions until ctx is done.
func (u *UI) loop(ctx context.Context, m *menuItems) {
	call := func(name string, fn func() error) {
		if fn == nil {
			return
		}
		if err := fn(); err != nil {
			u.log.Warn(name+" failed", "err", err)
			u.notify(AppName, name+": "+err.Error())
		}
	}
	currentCode := func() string {
		u.mu.Lock()
		defer u.mu.Unlock()
		return u.status.PairingCode
	}
	for {
		select {
		case <-ctx.Done():
			u.Quitting()
			systray.Quit()
			return
		case <-m.update.ClickedCh:
			call(AppName, u.actions.OpenUpdatePage)
		case <-m.pair.ClickedCh:
			call(m.l.Pair, u.actions.Pair)
		case <-m.code.ClickedCh:
			code := currentCode()
			if code == "" || u.actions.CopyToClipboard == nil {
				continue
			}
			if err := u.actions.CopyToClipboard(code); err != nil {
				u.log.Warn("copy code failed", "err", err)
				u.notify(AppName, err.Error())
			} else {
				u.notify(AppName, u.strings.Copied)
			}
		case <-m.showPage.ClickedCh:
			call(m.l.ShowPage, u.actions.ShowPairPage)
		case <-m.cancelPair.ClickedCh:
			if u.actions.CancelPairing != nil {
				u.actions.CancelPairing()
			}
		case <-m.ollama.ClickedCh:
			u.mu.Lock()
			running := u.status.Ollama == "running"
			u.mu.Unlock()
			if running {
				call(m.l.RestartOllama, u.actions.RestartOllama)
			} else {
				call(m.l.StartOllama, u.actions.StartOllama)
			}
		case <-m.download.ClickedCh:
			call(m.l.DownloadOllama, u.actions.OpenDownloadPage)
		case <-m.settings.ClickedCh:
			call(m.l.Settings, u.actions.OpenSettings)
		case <-m.autostart.ClickedCh:
			enable := !m.autostart.Checked()
			if u.actions.SetAutostart != nil {
				if err := u.actions.SetAutostart(enable); err != nil {
					u.log.Warn("autostart failed", "err", err)
					u.notify(AppName, m.l.Autostart+": "+err.Error())
					continue
				}
			}
			if enable {
				m.autostart.Check()
			} else {
				m.autostart.Uncheck()
			}
		case <-m.removePair.ClickedCh:
			call(m.l.ForgetBrowsers, u.actions.RemovePairings)
		case <-m.removeDev.ClickedCh:
			call(m.l.UnlinkDevice, u.actions.RemoveDevice)
		case <-m.quit.ClickedCh:
			// Order matters: stop touching the menu first, then start the app shutdown (which
			// pushes status updates we now ignore), then end the native loop.
			u.Quitting()
			if u.actions.Quit != nil {
				u.actions.Quit()
			}
			systray.Quit()
			return
		}
	}
}
