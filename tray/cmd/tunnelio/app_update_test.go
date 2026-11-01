package main

import (
	"io"
	"log/slog"
	"testing"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/relay"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/tray"
)

type countingNotifier struct{ bodies []string }

func (n *countingNotifier) Notify(_, body string) { n.bodies = append(n.bodies, body) }

func TestUpdateOfferFollowsTheWelcome(t *testing.T) {
	old := version
	t.Cleanup(func() { version = old })
	version = "0.1.0"
	n := &countingNotifier{}
	a := &app{log: slog.New(slog.NewTextHandler(io.Discard, nil)), notifier: n, strings: tray.StringsFor("en")}

	a.onLatest(&relay.Latest{Version: "0.2.0", URL: "https://example.com/#download"})
	if v, u := a.updateOffer(); v != "0.2.0" || u != "https://example.com/#download" {
		t.Fatalf("offer = %q %q", v, u)
	}
	a.onLatest(&relay.Latest{Version: "0.2.0", URL: "https://example.com/#download"}) // reconnect
	if len(n.bodies) != 1 {
		t.Fatalf("notified %d times, want once per version", len(n.bodies))
	}
	a.onLatest(nil) // the server stopped announcing it
	if v, _ := a.updateOffer(); v != "" {
		t.Fatalf("offer kept after the announcement went away: %q", v)
	}
	for _, l := range []*relay.Latest{
		{Version: "0.1.0", URL: "https://example.com/"}, // not newer
		{Version: "0.3.0", URL: "http://example.com/"},  // not https
		{Version: "0.3.0", URL: "javascript:alert(1)"},  // not a web page
	} {
		a.onLatest(l)
		if v, _ := a.updateOffer(); v != "" {
			t.Errorf("offered %q for %+v", v, *l)
		}
	}
	if err := a.openUpdatePage(); err == nil {
		t.Error("openUpdatePage without an offer should fail")
	}

	version = "dev-0b158da" // a build from source never asks
	a.onLatest(&relay.Latest{Version: "9.9.9", URL: "https://example.com/"})
	if v, _ := a.updateOffer(); v != "" {
		t.Errorf("a dev build was offered %q", v)
	}
}
