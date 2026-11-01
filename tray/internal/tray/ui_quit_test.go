package tray

import "testing"

// Once the UI is quitting, status updates must not reach the menu: on macOS every menu update
// runs synchronously on the main thread, which is gone after Quit, so an update sent during the
// shutdown (relay disconnect → status) would block forever and the process would never exit.
func TestNoMenuUpdatesWhileQuitting(t *testing.T) {
	u := New(nil, Actions{}, nil)
	u.mu.Lock()
	u.items = &menuItems{}
	u.mu.Unlock()
	if u.itemsForUpdate() == nil {
		t.Fatal("items should be rendered before quitting")
	}
	u.Quitting()
	if u.itemsForUpdate() != nil {
		t.Fatal("items must not be touched after Quitting")
	}
	u.SetStatus(Status{Relay: "offline"}) // no-op, must not block or panic
	u.ShowPairingCode("K7M3-ABCD-EFGH")   // idem
	if u.status.Relay != "offline" || u.status.PairingCode != "K7M3-ABCD-EFGH" {
		t.Fatal("state is still recorded while quitting")
	}
}
