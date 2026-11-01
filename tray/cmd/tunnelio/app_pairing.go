// Pairing callbacks: the SPAKE2 pairer drives these when the user starts a pairing from the menu.
package main

import (
	"errors"
	"time"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/config"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/pairing"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/relay"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/system"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/tray"
)

// ─── pairing callbacks ───────────────────────────────────────────────────────

func (a *app) startPairing() {
	if err := a.pairer.Start(); err != nil {
		if !errors.Is(err, pairing.ErrBusy) {
			a.log.Warn("pairing start failed", "err", err)
		}
		return
	}
}

func (a *app) onPairingCode(code string) {
	a.printf("PAIRING CODE: %s\n", code)
	if a.local != nil {
		a.local.SetPairing(code, a.pairer.Expires())
	}
	if a.ui != nil {
		a.ui.ShowPairingCode(code)
	}
	// GUI mode: the local page (code, QR, instructions, countdown) opens right away; the menu
	// item "Show QR code and instructions" reopens it while the code is still valid.
	if a.local != nil && a.ui != nil {
		if u, err := a.local.URL("/pair"); err != nil {
			a.log.Warn("pair page", "err", err)
		} else if err := system.OpenURL(u); err != nil {
			a.log.Warn("open pair page", "err", err)
		}
	}
}

func (a *app) onPairingResult(ok bool, err error) {
	if ok {
		a.printf("PAIRING OK\n")
		a.notifier.Notify(tray.AppName, a.strings.PairedOK)
	} else {
		a.printf("PAIRING FAILED: %v\n", err)
		if !a.opts.headless {
			if errors.Is(err, pairing.ErrCodeExpired) {
				a.notifier.Notify(tray.AppName, a.strings.CodeExpired)
			} else if !errors.Is(err, pairing.ErrAborted) {
				a.notifier.Notify(tray.AppName, a.strings.PairFailed+err.Error())
			}
		}
	}
	if a.local != nil {
		a.local.ClearPairing()
	}
	if a.ui != nil {
		a.ui.ShowPairingCode("")
	}
	a.pushStatus()
	// Headless and still unpaired: the only "menu action" is retrying with a fresh code.
	if a.opts.headless && !ok && !a.paired() {
		go func() {
			time.Sleep(headlessRetryDelay)
			if st, _ := a.relay.State(); st == relay.StateConnected && !a.paired() {
				a.startPairing()
			}
		}()
	}
}

func (a *app) onPaired(deviceID, deviceToken string) {
	d := &config.Device{DeviceID: deviceID, DeviceToken: deviceToken, ServerURL: a.cfg.ServerURL}
	if err := config.SaveDevice(a.paths, d); err != nil {
		a.log.Error("save device.json", "err", err)
		return
	}
	a.mu.Lock()
	a.device = d
	a.mu.Unlock()
	if err := a.manager.SetDeviceID(deviceID); err != nil {
		a.log.Error("device id", "err", err)
	}
	a.log.Info("device paired", "device", d)
	a.printf("PAIRED device_id=%s\n", deviceID)
	a.pushStatus()
}
