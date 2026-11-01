package release

import "testing"

func TestNewer(t *testing.T) {
	cases := []struct {
		current, latest string
		want            bool
	}{
		{"0.1.0", "0.2.0", true},
		{"v0.1.0", "0.1.1", true},
		{"0.1.9", "0.1.10", true},
		{"1.0.0", "0.9.9", false},
		{"0.2.0", "0.2.0", false},
		{"0.2.0", "v0.2.0", false},
		{"0.1.0-rc.7", "0.1.0", true},
		{"0.1.0", "0.1.0-rc.7", false},
		{"0.1.0-rc.2", "0.1.0-rc.10", true},
		{"0.1.0-rc.10", "0.1.0-rc.2", false},
		{"0.1.0-alpha", "0.1.0-beta", true},
		{"0.1.0-1", "0.1.0-alpha", true},
		{"0.1.0-rc", "0.1.0-rc.1", true},
		{"0.1.0+build.5", "0.1.1", true},
		// Builds from source and nonsense are never compared.
		{"dev", "9.9.9", false},
		{"dev-0b158da", "9.9.9", false},
		{"0.1.0", "", false},
		{"0.1.0", "latest", false},
		{"0.1", "0.2.0", false},
		{"0.1.0-", "0.2.0", false},
		{"0.-1.0", "0.2.0", false},
	}
	for _, c := range cases {
		if got := Newer(c.current, c.latest); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.current, c.latest, got, c.want)
		}
	}
}
