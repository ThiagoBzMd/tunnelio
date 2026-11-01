package system

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const ollamaExe = "ollama.exe"

func ollamaCandidates() []string {
	local := os.Getenv("LOCALAPPDATA")
	prog := os.Getenv("ProgramFiles")
	var out []string
	if local != "" {
		out = append(out, filepath.Join(local, "Programs", "Ollama", "ollama.exe"))
	}
	if prog != "" {
		out = append(out, filepath.Join(prog, "Ollama", "ollama.exe"))
	}
	return out
}

func detachAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS,
		HideWindow:    true,
	}
}

func stopOllama() error {
	return exec.Command("taskkill", "/IM", "ollama.exe", "/F").Run()
}

func openWithSystem(target string) error {
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", target) // #nosec G204 -- fixed program; target is a URL or a config path
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("system: open: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

const (
	runKeyPath  = `Software\Microsoft\Windows\CurrentVersion\Run`
	runKeyValue = "Tunnelio"
)

// AutostartEnabled reports whether the HKCU Run value exists.
func AutostartEnabled() (bool, error) {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath, registry.QUERY_VALUE)
	if err != nil {
		return false, err
	}
	defer k.Close()
	_, _, err = k.GetStringValue(runKeyValue)
	if errors.Is(err, registry.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// SetAutostart writes or deletes HKCU\...\Run\Tunnelio.
func SetAutostart(enable bool) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKeyPath, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if !enable {
		if err := k.DeleteValue(runKeyValue); err != nil && !errors.Is(err, registry.ErrNotExist) {
			return err
		}
		return nil
	}
	exe, err := ExecutablePath()
	if err != nil {
		return err
	}
	return k.SetStringValue(runKeyValue, `"`+exe+`"`)
}

// autostartPath is "" on Windows: autostart lives in the registry, not in a file.
func autostartPath() (string, error) { return "", nil }
