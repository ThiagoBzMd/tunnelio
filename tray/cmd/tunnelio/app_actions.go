// Tray menu actions (the ONLY surface for system actions, rule 5) and the hooks of the local pages.
package main

import (
	"errors"
	"os"
	"strings"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/config"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/history"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/localui"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/relay"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/system"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/tray"
)

// ─── tray menu actions (the ONLY surface for system actions) ─────────────────

func (a *app) actions() tray.Actions {
	return tray.Actions{
		Pair: func() error {
			if a.relay == nil {
				return errors.New("server URL not configured")
			}
			if st, _ := a.relay.State(); st != relay.StateConnected {
				return errors.New("not connected to the relay")
			}
			return a.pairer.Start()
		},
		CancelPairing:   a.pairer.Cancel,
		CopyToClipboard: system.CopyToClipboard,
		ShowPairPage: func() error {
			u, err := a.local.URL("/pair")
			if err != nil {
				return err
			}
			return system.OpenURL(u)
		},
		OpenSettings: func() error {
			u, err := a.local.URL("/settings")
			if err != nil {
				return err
			}
			return system.OpenURL(u)
		},
		StartOllama:      system.StartOllama,
		RestartOllama:    system.RestartOllama,
		OpenDownloadPage: func() error { return system.OpenURL(system.OllamaDownloadURL) },
		OpenUpdatePage:   a.openUpdatePage,
		AutostartEnabled: func() bool {
			on, err := system.AutostartEnabled()
			if err != nil {
				a.log.Debug("autostart state", "err", err)
			}
			return on
		},
		SetAutostart: func(enable bool) error {
			if err := system.SetAutostart(enable); err != nil {
				return err
			}
			a.cfg.Autostart = enable
			return config.SaveConfig(a.paths, a.cfg)
		},
		OpenConfigDir: func() error {
			if _, err := os.Stat(a.paths.ConfigFile); errors.Is(err, os.ErrNotExist) {
				if err := config.SaveConfig(a.paths, a.cfg); err != nil {
					return err
				}
			}
			return system.OpenFolder(a.paths.Dir)
		},
		RemovePairings: func() error {
			a.manager.CloseAll()
			if err := a.pairings.Clear(); err != nil {
				return err
			}
			a.notifier.Notify(tray.AppName, "All pairings removed.")
			return nil
		},
		RemoveDevice: func() error {
			a.manager.CloseAll()
			if err := a.pairings.Clear(); err != nil {
				return err
			}
			a.forgetDevice("removed from the menu")
			if err := a.wipeHistory(); err != nil {
				return err
			}
			if a.relay != nil {
				a.relay.Reconnect()
			}
			a.notifier.Notify(tray.AppName, "Device removed. Remove it from your account on the web too.")
			return nil
		},
		Quit: func() {
			if a.cancel != nil {
				a.cancel()
			}
		},
	}
}

// localHooks connects the loopback pages (QR/pairing, settings) to the app.
func (a *app) localHooks() localui.Hooks {
	return localui.Hooks{
		PairURL: func(code string) string {
			if a.cfg.ServerURL == "" {
				return ""
			}
			return strings.TrimRight(a.cfg.ServerURL, "/") + "/pair#" + strings.ReplaceAll(code, "-", "")
		},
		StartPairing: func() error {
			if a.pairer.Active() {
				return nil
			}
			return a.actions().Pair()
		},
		CancelPairing: a.pairer.Cancel,
		GetSettings: func() localui.Settings {
			on, _ := system.AutostartEnabled()
			return localui.Settings{ServerURL: a.cfg.ServerURL, OllamaURL: a.cfg.OllamaURL, DeviceName: a.cfg.DeviceName, Autostart: on}
		},
		SaveSettings: func(st localui.Settings) (bool, error) {
			restart := st.ServerURL != a.cfg.ServerURL || st.OllamaURL != a.cfg.OllamaURL
			if st.ServerURL != "" {
				a.cfg.ServerURL = st.ServerURL
			}
			if st.OllamaURL != "" {
				a.cfg.OllamaURL = st.OllamaURL
			}
			if st.DeviceName != "" {
				a.cfg.DeviceName = st.DeviceName
			}
			if on, _ := system.AutostartEnabled(); on != st.Autostart {
				if err := system.SetAutostart(st.Autostart); err != nil {
					return false, err
				}
			}
			a.cfg.Autostart = st.Autostart
			return restart, config.SaveConfig(a.paths, a.cfg)
		},
		OpenConfigDir: a.actions().OpenConfigDir,
	}
}

// wipeHistory deletes the private history file (SPEC §9.2) and reopens an empty store.
func (a *app) wipeHistory() error {
	if err := a.history.Close(); err != nil {
		return err
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Remove(a.paths.HistoryFile + suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	h, err := history.Open(a.paths.HistoryFile)
	if err != nil {
		return err
	}
	a.history = h
	return nil
}

// firstRunAutostartPrompt is the opt-in of tray rule 10: ask once, never enable silently.
func (a *app) firstRunAutostartPrompt() {
	if a.cfg.AutostartPrompted {
		return
	}
	a.cfg.AutostartPrompted = true
	if err := config.SaveConfig(a.paths, a.cfg); err != nil {
		a.log.Warn("save config", "err", err)
	}
	a.notifier.Notify(tray.AppName, "Welcome! To launch Tunnelio at login, enable 'Autostart' in the tray menu.")
}
