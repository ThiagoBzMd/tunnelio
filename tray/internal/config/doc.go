// Package config persists local settings under os.UserConfigDir()/tunnelio:
//
//	config.json    server_url, ollama_url (default http://127.0.0.1:11434), device_name, autostart
//	device.json    device_id, device_token           (0600)
//	pairings.json  [{pairing_id, pk, label, created_at}]  (0600)
//	history.sqlite private history (package history)
//
// Secrets are never logged. Keyring storage is a possible improvement.
package config
