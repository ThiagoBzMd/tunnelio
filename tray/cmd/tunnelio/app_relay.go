// Relay callbacks and the transports that connect the relay client to the channel manager and
// the pairer.
package main

import (
	"encoding/json"
	"log/slog"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/relay"
)

// ─── relay callbacks ─────────────────────────────────────────────────────────

func (a *app) relayHandlers() relay.Handlers {
	return relay.Handlers{
		OnConnected: func(w relay.Welcome) {
			a.mu.Lock()
			a.relayState = relay.StateConnected
			pair := a.pairOnce
			a.pairOnce = false
			unpaired := a.device == nil
			a.mu.Unlock()
			if w.DeviceID != nil && *w.DeviceID != "" {
				if err := a.manager.SetDeviceID(*w.DeviceID); err != nil {
					a.log.Error("welcome device id", "err", err)
				}
			}
			a.printf("RELAY connected\n")
			a.onLatest(w.Latest)
			a.pushStatus()
			if pair || (a.opts.headless && unpaired) {
				a.startPairing()
			}
		},
		OnDisconnected: func(code int, err error) {
			a.mu.Lock()
			a.relayState = relay.StateOffline
			a.mu.Unlock()
			a.printf("RELAY disconnected code=%d\n", code)
			a.manager.OnDisconnected()
			a.pairer.HandleDisconnected()
			a.pushStatus()
		},
		OnPairReady:   a.pairer.HandlePairReady,
		OnPairJoined:  a.pairer.HandlePairJoined,
		OnPairMsg:     a.pairer.HandlePairMsg,
		OnPaired:      a.pairer.HandlePaired,
		OnPairAborted: a.pairer.HandlePairAborted,
		OnSessionOpen: func(clientID string) {
			a.manager.OnSessionOpen(clientID)
			a.printf("SESSION %s opened\n", clientID)
			a.pushStatus()
		},
		OnSessionClosed: func(clientID, reason string) {
			a.manager.OnSessionClosed(clientID, reason)
			a.printf("SESSION %s closed reason=%s\n", clientID, reason)
			a.pushStatus()
		},
		OnData:         a.manager.OnData,
		OnRevoked:      func(reason string) { a.forgetDevice("revoked: " + reason) },
		OnUnauthorized: func() { a.forgetDevice("unauthorized (4001)") },
		OnReplaced:     func() { a.log.Warn("another connection of this device replaced ours (4006)") },
		OnError:        func(code, msg string) { a.log.Warn("relay error", "code", code, "message", msg) },
	}
}

// relayTransport adapts the relay client for package channel (nil-safe when unconfigured).
type relayTransport struct{ a *app }

func (t relayTransport) SendData(clientID string, payload json.RawMessage) error {
	if t.a.relay == nil {
		return relay.ErrNotConnected
	}
	return t.a.relay.SendData(clientID, payload)
}

func (t relayTransport) SendClose(clientID string) error {
	if t.a.relay == nil {
		return relay.ErrNotConnected
	}
	return t.a.relay.SendClose(clientID)
}

// pairerTransport adapts the relay client for package pairing.
type pairerTransport struct{ a *app }

func (t pairerTransport) SendPairStart() error {
	if t.a.relay == nil {
		return relay.ErrNotConnected
	}
	return t.a.relay.SendPairStart()
}

func (t pairerTransport) SendPairMsg(p json.RawMessage) error {
	if t.a.relay == nil {
		return relay.ErrNotConnected
	}
	return t.a.relay.SendPairMsg(p)
}

func (t pairerTransport) SendPairDone(ok bool, name string) error {
	if t.a.relay == nil {
		return relay.ErrNotConnected
	}
	return t.a.relay.SendPairDone(ok, name)
}

// logNotifier is the headless notification sink.
type logNotifier struct{ log *slog.Logger }

func (n logNotifier) Notify(title, body string) {
	n.log.Info("notification", "title", title, "body", body)
}
