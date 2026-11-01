// Package system is the ONLY package allowed to import os/exec (enforced by depguard in
// .golangci.yml and by a test that parses imports of every other package).
//
// Responsibilities: detect Ollama (running / installed-but-stopped / not installed), start or
// restart it, open the download page, and manage autostart (Windows Run key, macOS LaunchAgent,
// Linux ~/.config/autostart). Every function here is invoked exclusively from the tray menu.
package system
