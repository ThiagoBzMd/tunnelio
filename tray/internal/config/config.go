package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/crypto"
)

const (
	// DirName is the folder under os.UserConfigDir().
	DirName = "tunnelio"
	// EnvConfigDir overrides the config directory.
	EnvConfigDir = "TUNNELIO_CONFIG_DIR"
	// EnvServerURL overrides config.server_url.
	EnvServerURL = "TUNNELIO_SERVER_URL"
	// EnvOllamaURL overrides config.ollama_url.
	EnvOllamaURL = "TUNNELIO_OLLAMA_URL"
	// DefaultOllamaURL is the default local Ollama address.
	DefaultOllamaURL = "http://127.0.0.1:11434"

	secretMode = 0o600
	dirMode    = 0o700
)

// Paths are the files under the config directory.
type Paths struct {
	Dir          string
	ConfigFile   string // config.json
	DeviceFile   string // device.json   (0600)
	PairingsFile string // pairings.json (0600)
	HistoryFile  string // history.sqlite
}

// ResolveDir picks the config directory: explicit override, then $TUNNELIO_CONFIG_DIR, then
// os.UserConfigDir()/tunnelio. The directory is created with mode 0700, and an existing one that
// other accounts can read is closed to 0700.
func ResolveDir(override string) (string, error) {
	dir := override
	if dir == "" {
		dir = os.Getenv(EnvConfigDir)
	}
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("config: user config dir: %w", err)
		}
		dir = filepath.Join(base, DirName)
	}
	dir = filepath.Clean(dir)
	if err := os.MkdirAll(dir, dirMode); err != nil { // #nosec G703 -- the config dir is chosen by the user (--config-dir / env); creating it is the point
		return "", fmt.Errorf("config: create %s: %w", dir, err)
	}
	closeToOthers(dir, dirMode)
	return dir, nil
}

// closeToOthers sets mode on path when other accounts can read it: MkdirAll and OpenFile keep
// the mode of what already exists, and a folder or file made earlier (by an older version, a
// script or by hand) may be open. Best effort: on Windows the profile's ACL already keeps other
// accounts out and Chmod cannot express it; a failure leaves the path as it was.
func closeToOthers(path string, mode os.FileMode) {
	if runtime.GOOS == "windows" {
		return
	}
	if st, err := os.Stat(path); err == nil && st.Mode().Perm()&0o077 != 0 { // #nosec G703 -- the tray's own config dir (--config-dir / env)
		_ = os.Chmod(path, mode) // #nosec G302 G703 -- 0700 for a directory, 0600 for files, in the tray's own config dir
	}
}

// CloseToOthers makes a file in the config directory readable only by this account (0600).
func CloseToOthers(path string) { closeToOthers(path, secretMode) }

// NewPaths maps the files inside dir.
func NewPaths(dir string) Paths {
	return Paths{
		Dir:          dir,
		ConfigFile:   filepath.Join(dir, "config.json"),
		DeviceFile:   filepath.Join(dir, "device.json"),
		PairingsFile: filepath.Join(dir, "pairings.json"),
		HistoryFile:  filepath.Join(dir, "history.sqlite"),
	}
}

// Config is config.json. No secrets live here.
type Config struct {
	ServerURL              string `json:"server_url"`
	OllamaURL              string `json:"ollama_url"`
	DeviceName             string `json:"device_name"`
	Autostart              bool   `json:"autostart"`
	AllowNonLoopbackOllama bool   `json:"allow_non_loopback_ollama"`
	// AutostartPrompted records that the first-run opt-in question was already asked (tray mode).
	AutostartPrompted bool `json:"autostart_prompted"`
}

// LoadConfig reads config.json, applying defaults for missing fields. A missing file is not an error.
func LoadConfig(p Paths) (*Config, error) {
	c := &Config{}
	data, err := os.ReadFile(p.ConfigFile)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return nil, fmt.Errorf("config: read %s: %w", p.ConfigFile, err)
	default:
		if err := json.Unmarshal(data, c); err != nil {
			return nil, fmt.Errorf("config: parse %s: %w", p.ConfigFile, err)
		}
	}
	c.applyDefaults()
	return c, nil
}

func (c *Config) applyDefaults() {
	if c.OllamaURL == "" {
		c.OllamaURL = DefaultOllamaURL
	}
	if c.DeviceName == "" {
		if h, err := os.Hostname(); err == nil && h != "" {
			c.DeviceName = h
		} else {
			c.DeviceName = "tunnelio"
		}
	}
}

// ApplyEnv overlays TUNNELIO_SERVER_URL / TUNNELIO_OLLAMA_URL. Not persisted by itself.
func (c *Config) ApplyEnv() {
	if v := os.Getenv(EnvServerURL); v != "" {
		c.ServerURL = v
	}
	if v := os.Getenv(EnvOllamaURL); v != "" {
		c.OllamaURL = v
	}
}

// SaveConfig writes config.json atomically.
func SaveConfig(p Paths, c *Config) error {
	return writeJSON(p.ConfigFile, c)
}

// Device is device.json (SPEC §4.7): the relay identity and token. Mode 0600.
type Device struct {
	DeviceID    string `json:"device_id"`
	DeviceToken string `json:"device_token"`
	ServerURL   string `json:"server_url,omitempty"`
}

// LogValue redacts the token so a Device can be logged safely.
func (d *Device) LogValue() slog.Value {
	if d == nil {
		return slog.StringValue("<unpaired>")
	}
	return slog.GroupValue(slog.String("device_id", d.DeviceID), slog.String("device_token", "<redacted>"))
}

// LoadDevice returns nil, nil when device.json does not exist (unpaired).
func LoadDevice(p Paths) (*Device, error) {
	data, err := os.ReadFile(p.DeviceFile)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("config: read device file: %w", err)
	}
	var d Device
	if err := json.Unmarshal(data, &d); err != nil {
		return nil, fmt.Errorf("config: parse device file: %w", err)
	}
	if d.DeviceID == "" || d.DeviceToken == "" {
		return nil, errors.New("config: device file is incomplete")
	}
	return &d, nil
}

// SaveDevice writes device.json with mode 0600.
func SaveDevice(p Paths, d *Device) error { return writeJSON(p.DeviceFile, d) }

// DeleteDevice removes device.json (unpair). Missing file is not an error.
func DeleteDevice(p Paths) error {
	if err := os.Remove(p.DeviceFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Pairing is one entry of pairings.json. PairingID and PK are base64url.
type Pairing struct {
	PairingID string `json:"pairing_id"`
	PK        string `json:"pk"`
	Label     string `json:"label"`
	CreatedAt string `json:"created_at"`
}

// PairingInfo is a Pairing without the key (for menus/logs).
type PairingInfo struct {
	PairingID string
	Label     string
	CreatedAt string
}

// Pairings is the in-memory view of pairings.json; every mutation is persisted immediately.
type Pairings struct {
	mu    sync.RWMutex
	path  string
	items []Pairing
}

// LoadPairings reads pairings.json (missing = empty list).
func LoadPairings(p Paths) (*Pairings, error) {
	ps := &Pairings{path: p.PairingsFile}
	data, err := os.ReadFile(p.PairingsFile)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return ps, nil
	case err != nil:
		return nil, fmt.Errorf("config: read pairings: %w", err)
	}
	if err := json.Unmarshal(data, &ps.items); err != nil {
		return nil, fmt.Errorf("config: parse pairings: %w", err)
	}
	return ps, nil
}

// Lookup returns the PK for a raw 16-byte pairing_id.
func (ps *Pairings) Lookup(pairingID []byte) ([]byte, bool) {
	id := crypto.B64(pairingID)
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	for _, it := range ps.items {
		if it.PairingID == id {
			pk, err := crypto.B64Decode(it.PK)
			if err != nil || len(pk) != 32 {
				return nil, false
			}
			return pk, true
		}
	}
	return nil, false
}

// Add stores (or replaces) a pairing and persists the file before returning.
func (ps *Pairings) Add(pairingID, pk []byte, label string) error {
	entry := Pairing{PairingID: crypto.B64(pairingID), PK: crypto.B64(pk), Label: label,
		CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	replaced := false
	for i := range ps.items {
		if ps.items[i].PairingID == entry.PairingID {
			ps.items[i] = entry
			replaced = true
		}
	}
	if !replaced {
		ps.items = append(ps.items, entry)
	}
	return writeJSON(ps.path, ps.items)
}

// Clear removes every pairing and persists.
func (ps *Pairings) Clear() error {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	ps.items = nil
	return writeJSON(ps.path, []Pairing{})
}

// Count returns the number of pairings.
func (ps *Pairings) Count() int {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	return len(ps.items)
}

// List returns pairing metadata without keys.
func (ps *Pairings) List() []PairingInfo {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	out := make([]PairingInfo, 0, len(ps.items))
	for _, it := range ps.items {
		out = append(out, PairingInfo{PairingID: it.PairingID, Label: it.Label, CreatedAt: it.CreatedAt})
	}
	return out
}

// writeJSON writes v to path atomically (temp file + rename) with mode 0600.
func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(path), dirMode); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, secretMode); err != nil {
		return err
	}
	if err := os.Chmod(tmp, secretMode); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
