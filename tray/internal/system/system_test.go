package system

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type fakeVersion struct {
	v   string
	err error
}

func (f fakeVersion) Version(context.Context) (string, error) { return f.v, f.err }

func TestDetectOllama(t *testing.T) {
	st := DetectOllama(context.Background(), fakeVersion{v: "1.2.3"})
	if st.State != OllamaRunning || st.Version != "1.2.3" {
		t.Errorf("running = %+v", st)
	}
	// Force "not found": empty PATH and no candidates present (candidates are absolute paths
	// that normally do not exist on CI machines; skip the assertion if one does).
	t.Setenv("PATH", t.TempDir())
	st = DetectOllama(context.Background(), fakeVersion{err: errors.New("down")})
	if bin := OllamaBinary(); bin != "" {
		t.Logf("ollama binary present at %s: state=%s", bin, st.State)
		if st.State != OllamaStopped {
			t.Errorf("expected stopped, got %s", st.State)
		}
		return
	}
	if st.State != OllamaNotInstalled {
		t.Errorf("not installed = %+v", st)
	}
	if err := StartOllama(); !errors.Is(err, ErrOllamaNotInstalled) {
		t.Errorf("StartOllama without binary = %v", err)
	}
}

func TestAutostartFile(t *testing.T) {
	switch runtime.GOOS {
	case "linux":
		t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	case "darwin":
		t.Setenv("HOME", t.TempDir())
	default:
		if os.Getenv("TUNNELIO_TEST_REGISTRY") == "" {
			t.Skip("set TUNNELIO_TEST_REGISTRY=1 to exercise the Windows Run key")
		}
	}
	on, err := AutostartEnabled()
	if err != nil && runtime.GOOS != "windows" {
		t.Fatal(err)
	}
	if on {
		t.Fatal("autostart already enabled in a fresh home")
	}
	if err := SetAutostart(true); err != nil {
		t.Fatal(err)
	}
	on, err = AutostartEnabled()
	if err != nil || !on {
		t.Fatalf("after enable: %v, %v", on, err)
	}
	exe, _ := ExecutablePath()
	if p, _ := autostartPath(); p != "" {
		data, err := os.ReadFile(filepath.Clean(p))
		if err != nil {
			t.Fatal(err)
		}
		marker := map[string]string{"linux": "[Desktop Entry]", "darwin": "app.tunnelio.tray"}[runtime.GOOS]
		if !strings.Contains(string(data), marker) || !strings.Contains(string(data), filepath.Base(exe)) {
			t.Errorf("autostart entry = %s", data)
		}
	}
	if err := SetAutostart(false); err != nil {
		t.Fatal(err)
	}
	if on, _ := AutostartEnabled(); on {
		t.Error("still enabled after disable")
	}
	if err := SetAutostart(false); err != nil {
		t.Error("disable twice should be a no-op")
	}
}
