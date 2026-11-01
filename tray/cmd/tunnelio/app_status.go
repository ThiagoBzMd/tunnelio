// Status and identity helpers of the app: Ollama detection, status pushes to the menu and the
// local pages, and forgetting the device identity.
package main

import (
	"context"
	"time"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/channel"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/config"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/localui"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/system"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/tray"
)

// ─── state helpers ───────────────────────────────────────────────────────────

func (a *app) token() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.device == nil {
		return ""
	}
	return a.device.DeviceToken
}

func (a *app) paired() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.device != nil
}

func (a *app) ollamaStatus() channel.OllamaStatus {
	a.mu.Lock()
	defer a.mu.Unlock()
	return channel.OllamaStatus{Status: a.ollamaState.State, Version: a.ollamaState.Version}
}

func (a *app) detectOllama(ctx context.Context) bool {
	st := system.DetectOllama(ctx, a.ollama)
	a.mu.Lock()
	changed := st.State != a.ollamaState.State || st.Version != a.ollamaState.Version
	a.ollamaState = st
	a.mu.Unlock()
	if changed {
		a.log.Info("ollama status", "state", st.State, "version", st.Version, "binary", st.Binary)
		a.manager.BroadcastDeviceInfo()
		a.pushStatus()
	}
	return changed
}

func (a *app) watchOllama(ctx context.Context) {
	t := time.NewTicker(system.DetectInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.detectOllama(ctx)
		}
	}
}

func (a *app) pushStatus() {
	if a.ui == nil {
		return
	}
	a.mu.Lock()
	st := tray.Status{
		Ollama:        a.ollamaState.State,
		OllamaVersion: a.ollamaState.Version,
		Relay:         a.relayState.String(),
		Paired:        a.device != nil,
		Sessions:      a.manager.Sessions(),
		ServerURL:     a.cfg.ServerURL,
	}
	a.mu.Unlock()
	st.UpdateVersion, _ = a.updateOffer()
	a.ui.SetStatus(st)
	if a.local != nil {
		a.local.SetStatus(localui.Status{Ollama: st.Ollama, OllamaVersion: st.OllamaVersion, Relay: st.Relay, Paired: st.Paired})
	}
}

// forgetDevice drops device.json and the identity (close 4001 / revoked / menu).
func (a *app) forgetDevice(reason string) {
	a.mu.Lock()
	had := a.device != nil
	a.device = nil
	a.mu.Unlock()
	if err := config.DeleteDevice(a.paths); err != nil {
		a.log.Warn("delete device.json", "err", err)
	}
	// Unlinking ends the account relationship: paired browsers lose access too (SPEC §4.7).
	if err := a.pairings.Clear(); err != nil {
		a.log.Warn("clear pairings.json", "err", err)
	}
	_ = a.manager.SetDeviceID("")
	a.manager.OnDisconnected()
	if had {
		a.log.Warn("device identity removed", "reason", reason)
		a.printf("UNPAIRED reason=%s\n", reason)
	}
	a.pushStatus()
}
