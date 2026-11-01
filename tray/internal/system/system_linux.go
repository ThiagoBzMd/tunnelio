package system

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

const ollamaExe = "ollama"

func ollamaCandidates() []string {
	home, _ := os.UserHomeDir()
	return []string{
		"/usr/local/bin/ollama",
		"/usr/bin/ollama",
		"/opt/ollama/bin/ollama",
		filepath.Join(home, ".local", "bin", "ollama"),
	}
}

func detachAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

func stopOllama() error {
	return exec.Command("pkill", "-x", "ollama").Run()
}

func openWithSystem(target string) error {
	cmd := exec.Command("xdg-open", target) // #nosec G204 -- fixed program; target is a URL or a config path
	cmd.SysProcAttr = detachAttr()
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("system: xdg-open: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// autostartFile is ~/.config/autostart/tunnelio.desktop (XDG autostart).
func autostartFile() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "autostart", "tunnelio.desktop"), nil
}

// AutostartEnabled reports whether the XDG autostart entry exists.
func AutostartEnabled() (bool, error) {
	p, err := autostartFile()
	if err != nil {
		return false, err
	}
	_, err = os.Stat(p)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// SetAutostart creates or removes the XDG autostart entry.
func SetAutostart(enable bool) error {
	p, err := autostartFile()
	if err != nil {
		return err
	}
	if !enable {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	exe, err := ExecutablePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	content := strings.Join([]string{
		"[Desktop Entry]",
		"Type=Application",
		"Name=Tunnelio",
		"Comment=Use your local Ollama models from any browser, end-to-end encrypted",
		"Exec=" + desktopQuote(exe),
		"Icon=tunnelio",
		"Terminal=false",
		"X-GNOME-Autostart-enabled=true",
		"",
	}, "\n")
	return os.WriteFile(p, []byte(content), 0o644) // #nosec G306 -- desktop entry, not a secret
}

// desktopQuote quotes an Exec= value per the Desktop Entry spec.
func desktopQuote(s string) string {
	if !strings.ContainsAny(s, " \t\"'\\$`") {
		return s
	}
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "`", "\\`", "$", `\$`)
	return `"` + r.Replace(s) + `"`
}

// autostartPath is the platform autostart entry (used by tests).
func autostartPath() (string, error) { return autostartFile() }
