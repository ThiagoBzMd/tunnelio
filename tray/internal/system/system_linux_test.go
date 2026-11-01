package system

import "testing"

func TestDesktopQuote(t *testing.T) {
	if got := desktopQuote("/usr/bin/tunnelio"); got != "/usr/bin/tunnelio" {
		t.Errorf("got %q", got)
	}
	if got := desktopQuote(`/home/me/my app/tunnelio`); got != `"/home/me/my app/tunnelio"` {
		t.Errorf("got %q", got)
	}
}
