package system

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

const ollamaExe = "ollama"

func ollamaCandidates() []string {
	home, _ := os.UserHomeDir()
	return []string{
		"/usr/local/bin/ollama",
		"/opt/homebrew/bin/ollama",
		"/Applications/Ollama.app/Contents/Resources/ollama",
		filepath.Join(home, "Applications", "Ollama.app", "Contents", "Resources", "ollama"),
	}
}

func detachAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

func stopOllama() error {
	return exec.Command("pkill", "-x", "ollama").Run()
}

func openWithSystem(target string) error {
	cmd := exec.Command("open", target) // #nosec G204 -- fixed program; target is a URL or a config path
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("system: open: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// launchAgentLabel is the LaunchAgent identifier.
const launchAgentLabel = "app.tunnelio.tray"

func launchAgentFile() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist"), nil
}

// AutostartEnabled reports whether the LaunchAgent plist exists.
func AutostartEnabled() (bool, error) {
	p, err := launchAgentFile()
	if err != nil {
		return false, err
	}
	_, err = os.Stat(p)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// SetAutostart writes or removes ~/Library/LaunchAgents/app.tunnelio.tray.plist.
func SetAutostart(enable bool) error {
	p, err := launchAgentFile()
	if err != nil {
		return err
	}
	if !enable {
		_ = exec.Command("launchctl", "unload", p).Run()
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	exe, err := ExecutablePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>%s</string>
	<key>ProgramArguments</key>
	<array>
		<string>%s</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<false/>
	<key>ProcessType</key>
	<string>Interactive</string>
</dict>
</plist>
`, launchAgentLabel, xmlEscape(exe))
	if err := os.WriteFile(p, []byte(plist), 0o644); err != nil { // #nosec G306 -- plist, not a secret
		return err
	}
	_ = exec.Command("launchctl", "load", p).Run()
	return nil
}

func xmlEscape(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '&':
			out = append(out, "&amp;"...)
		case '<':
			out = append(out, "&lt;"...)
		case '>':
			out = append(out, "&gt;"...)
		default:
			out = append(out, s[i])
		}
	}
	return string(out)
}

// autostartPath is the platform autostart entry (used by tests).
func autostartPath() (string, error) { return launchAgentFile() }
