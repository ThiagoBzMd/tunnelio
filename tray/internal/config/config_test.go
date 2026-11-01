package config

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestResolveDir(t *testing.T) {
	base := t.TempDir()
	t.Setenv(EnvConfigDir, filepath.Join(base, "env"))
	dir, err := ResolveDir("")
	if err != nil || dir != filepath.Join(base, "env") {
		t.Fatalf("ResolveDir(env) = %q, %v", dir, err)
	}
	dir, err = ResolveDir(filepath.Join(base, "flag"))
	if err != nil || dir != filepath.Join(base, "flag") {
		t.Fatalf("ResolveDir(flag) = %q, %v", dir, err)
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		t.Fatalf("dir not created: %v", err)
	}
}

func TestResolveDirIsClosedToOtherAccounts(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the user profile's ACL protects the folder on Windows")
	}
	base := t.TempDir()
	fresh, err := ResolveDir(filepath.Join(base, "new"))
	if err != nil {
		t.Fatal(err)
	}
	// One made earlier and open to other accounts (an older version, a script, by hand).
	open := filepath.Join(base, "open")
	if err := os.Mkdir(open, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(open, 0o775); err != nil { //nolint:gosec // deliberately open, as an older version left it
		t.Fatal(err)
	}
	if _, err := ResolveDir(open); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{fresh, open} {
		if st, err := os.Stat(d); err != nil || st.Mode().Perm() != 0o700 {
			t.Errorf("%s: %v %v, want 0700", filepath.Base(d), st.Mode().Perm(), err)
		}
	}
	// A file made earlier with the default mode.
	f := filepath.Join(open, "tray.log")
	if err := os.WriteFile(f, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(f, 0o664); err != nil { //nolint:gosec // deliberately open, as an older version left it
		t.Fatal(err)
	}
	CloseToOthers(f)
	if st, err := os.Stat(f); err != nil || st.Mode().Perm() != 0o600 {
		t.Errorf("tray.log: %v %v, want 0600", st.Mode().Perm(), err)
	}
}

func TestConfigDefaultsEnvAndSave(t *testing.T) {
	p := NewPaths(t.TempDir())
	c, err := LoadConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.OllamaURL != DefaultOllamaURL || c.DeviceName == "" || c.ServerURL != "" {
		t.Errorf("defaults = %+v", c)
	}
	t.Setenv(EnvServerURL, "https://relay.example")
	t.Setenv(EnvOllamaURL, "http://127.0.0.1:1")
	c.ApplyEnv()
	if c.ServerURL != "https://relay.example" || c.OllamaURL != "http://127.0.0.1:1" {
		t.Errorf("env overlay = %+v", c)
	}
	c.Autostart = true
	if err := SaveConfig(p, c); err != nil {
		t.Fatal(err)
	}
	c2, err := LoadConfig(p)
	if err != nil || !c2.Autostart || c2.ServerURL != "https://relay.example" {
		t.Errorf("reload = %+v, %v", c2, err)
	}
	if err := os.WriteFile(p.ConfigFile, []byte("{bad"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(p); err == nil {
		t.Error("corrupt config accepted")
	}
}

func TestDeviceFile(t *testing.T) {
	p := NewPaths(t.TempDir())
	d, err := LoadDevice(p)
	if err != nil || d != nil {
		t.Fatalf("missing device = %+v, %v", d, err)
	}
	if err := SaveDevice(p, &Device{DeviceID: "0192f6a0-5e7b-7c3d-9a4e-1b2c3d4e5f60", DeviceToken: "secret-token"}); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		st, err := os.Stat(p.DeviceFile)
		if err != nil || st.Mode().Perm() != 0o600 {
			t.Errorf("device.json mode = %v, %v", st.Mode(), err)
		}
	}
	d, err = LoadDevice(p)
	if err != nil || d == nil || d.DeviceToken != "secret-token" {
		t.Fatalf("LoadDevice = %+v, %v", d, err)
	}
	if s := d.LogValue().String(); bytes.Contains([]byte(s), []byte("secret-token")) {
		t.Errorf("LogValue leaks the token: %s", s)
	}
	if err := DeleteDevice(p); err != nil {
		t.Fatal(err)
	}
	if err := DeleteDevice(p); err != nil {
		t.Fatal("second delete should be a no-op")
	}
	if d, _ := LoadDevice(p); d != nil {
		t.Error("device still present after delete")
	}
}

func TestPairings(t *testing.T) {
	p := NewPaths(t.TempDir())
	ps, err := LoadPairings(p)
	if err != nil || ps.Count() != 0 {
		t.Fatal(err)
	}
	id := bytes.Repeat([]byte{1}, 16)
	pk := bytes.Repeat([]byte{2}, 32)
	if err := ps.Add(id, pk, "Firefox"); err != nil {
		t.Fatal(err)
	}
	if got, ok := ps.Lookup(id); !ok || !bytes.Equal(got, pk) {
		t.Errorf("Lookup = %x, %v", got, ok)
	}
	if _, ok := ps.Lookup(bytes.Repeat([]byte{9}, 16)); ok {
		t.Error("unknown pairing found")
	}
	// Replace with a new key for the same id.
	pk2 := bytes.Repeat([]byte{3}, 32)
	if err := ps.Add(id, pk2, "Firefox"); err != nil {
		t.Fatal(err)
	}
	ps2, err := LoadPairings(p)
	if err != nil || ps2.Count() != 1 {
		t.Fatalf("reload = %d, %v", ps2.Count(), err)
	}
	if got, _ := ps2.Lookup(id); !bytes.Equal(got, pk2) {
		t.Error("replacement not persisted")
	}
	if list := ps2.List(); len(list) != 1 || list[0].Label != "Firefox" {
		t.Errorf("List = %+v", list)
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(p.PairingsFile)
		if st.Mode().Perm() != 0o600 {
			t.Errorf("pairings.json mode = %v", st.Mode())
		}
	}
	if err := ps2.Clear(); err != nil || ps2.Count() != 0 {
		t.Fatal(err)
	}
	ps3, _ := LoadPairings(p)
	if ps3.Count() != 0 {
		t.Error("clear not persisted")
	}
}
