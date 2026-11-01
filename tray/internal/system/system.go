package system

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// Ollama detection states (SPEC §8.5).
const (
	OllamaRunning      = "running"
	OllamaStopped      = "stopped"
	OllamaNotInstalled = "not_installed"
)

// OllamaDownloadURL is the page opened by "Open Ollama download page".
const OllamaDownloadURL = "https://ollama.com/download"

// DetectInterval is how often the tray polls /api/version.
const DetectInterval = 15 * time.Second

// VersionClient is the part of the Ollama client used for detection.
type VersionClient interface {
	Version(ctx context.Context) (string, error)
}

// OllamaStatus is the result of DetectOllama.
type OllamaStatus struct {
	State   string // running | stopped | not_installed
	Version string // when running
	Binary  string // path found, when installed
}

// DetectOllama probes /api/version and, if it does not answer, looks for the binary.
func DetectOllama(ctx context.Context, client VersionClient) OllamaStatus {
	if client != nil {
		vctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		v, err := client.Version(vctx)
		cancel()
		if err == nil {
			return OllamaStatus{State: OllamaRunning, Version: v, Binary: OllamaBinary()}
		}
	}
	if bin := OllamaBinary(); bin != "" {
		return OllamaStatus{State: OllamaStopped, Binary: bin}
	}
	return OllamaStatus{State: OllamaNotInstalled}
}

// OllamaBinary returns the path of the ollama executable (PATH first, then the default install
// locations of the platform) or "" when not installed.
func OllamaBinary() string {
	if p, err := exec.LookPath(ollamaExe); err == nil {
		return p
	}
	for _, c := range ollamaCandidates() {
		if c == "" {
			continue
		}
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
}

// ErrOllamaNotInstalled is returned by StartOllama when no binary is found.
var ErrOllamaNotInstalled = errors.New("system: ollama is not installed")

// StartOllama launches `ollama serve` detached from this process.
func StartOllama() error {
	bin := OllamaBinary()
	if bin == "" {
		return ErrOllamaNotInstalled
	}
	return startDetached(bin, "serve")
}

// RestartOllama stops any running ollama server (best effort) and starts it again.
func RestartOllama() error {
	if OllamaBinary() == "" {
		return ErrOllamaNotInstalled
	}
	_ = stopOllama()
	time.Sleep(time.Second)
	return StartOllama()
}

// OpenURL opens a URL in the default browser.
func OpenURL(url string) error {
	return openWithSystem(url)
}

// OpenFolder opens a directory in the file manager.
func OpenFolder(path string) error {
	return openWithSystem(filepath.Clean(path))
}

// startDetached runs bin with args, detached from the tray process and its console.
func startDetached(bin string, args ...string) error {
	cmd := exec.Command(bin, args...) // #nosec G204 -- bin comes from OllamaBinary (PATH/default locations), args are fixed
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	cmd.SysProcAttr = detachAttr()
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("system: start %s: %w", filepath.Base(bin), err)
	}
	// Reap the child in the background so it never becomes a zombie if it exits.
	go func() { _ = cmd.Wait() }()
	return nil
}

// ExecutablePath is the absolute path of the running binary (used for autostart entries).
func ExecutablePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Abs(exe)
}
