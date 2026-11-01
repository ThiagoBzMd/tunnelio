// Package tray builds the system tray icon and menu (fyne.io/systray) and local notifications
// (beeep). The menu is the ONLY surface for system actions (SPEC §8.5): start/restart Ollama,
// autostart opt-in, Ollama host/port, server URL, pair browser, remove pairings, remove device,
// quit. It calls package system for those actions; nothing in the channel can reach them.
package tray
