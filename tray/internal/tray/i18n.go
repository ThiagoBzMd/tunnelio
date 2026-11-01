package tray

import "github.com/ThiagoBzMd/tunnelio/tray/internal/localui"

// Labels are the tray menu strings. Tray menus cannot show tooltips on most desktops, so the
// labels themselves must explain the action.
type Labels struct {
	Starting, Pair, CodeFmt, ShowPage, CancelPair, StartOllama, RestartOllama, OllamaNotInstalled string
	DownloadOllama, Settings, Autostart, ForgetBrowsers, UnlinkDevice, Quit                       string
	StatusFmt, RelayConnected, RelayConnecting, RelayOffline, Paired, NotPaired, Sessions         string
	OllamaRunning, OllamaStopped, OllamaMissing                                                   string
	UpdateFmt                                                                                     string // %s = the new version
}

var labels = map[localui.Lang]Labels{
	localui.LangEN: {
		Starting: "Starting…", Pair: "Pair a device…", CodeFmt: "Code: %s   (click to copy)",
		ShowPage: "Show QR code and instructions", CancelPair: "Cancel pairing",
		StartOllama: "Start Ollama", RestartOllama: "Restart Ollama", OllamaNotInstalled: "Ollama is not installed",
		DownloadOllama: "Download Ollama", Settings: "Settings…", Autostart: "Start at login",
		ForgetBrowsers: "Forget paired devices", UnlinkDevice: "Unlink this computer from the account", Quit: "Quit",
		StatusFmt: "Ollama: %s · Relay: %s", RelayConnected: "connected", RelayConnecting: "connecting…", RelayOffline: "offline",
		Paired: "paired", NotPaired: "not paired", Sessions: "%d session(s)",
		OllamaRunning: "running %s", OllamaStopped: "stopped", OllamaMissing: "not installed",
		UpdateFmt: "New version %s — download",
	},
	localui.LangPTBR: {
		Starting: "Iniciando…", Pair: "Parear um dispositivo…", CodeFmt: "Código: %s   (clique para copiar)",
		ShowPage: "Mostrar QR code e instruções", CancelPair: "Cancelar pareamento",
		StartOllama: "Iniciar Ollama", RestartOllama: "Reiniciar Ollama", OllamaNotInstalled: "Ollama não está instalado",
		DownloadOllama: "Baixar Ollama", Settings: "Configurações…", Autostart: "Iniciar junto com o sistema",
		ForgetBrowsers: "Esquecer dispositivos pareados", UnlinkDevice: "Desvincular este computador da conta", Quit: "Sair",
		StatusFmt: "Ollama: %s · Relay: %s", RelayConnected: "conectado", RelayConnecting: "conectando…", RelayOffline: "desconectado",
		Paired: "pareado", NotPaired: "não pareado", Sessions: "%d sessão(ões)",
		OllamaRunning: "rodando %s", OllamaStopped: "parado", OllamaMissing: "não instalado",
		UpdateFmt: "Nova versão %s — baixar",
	},
}

// LabelsFor returns the labels for lang (English fallback).
func LabelsFor(lang localui.Lang) Labels {
	if l, ok := labels[lang]; ok {
		return l
	}
	return labels[localui.LangEN]
}
