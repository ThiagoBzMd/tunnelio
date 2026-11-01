// Package localui serves the tray's local web pages (pairing QR + instructions, settings) on
// 127.0.0.1 only, behind a random token. Tray menus cannot show images or forms, so anything
// richer than a label opens here in the default browser. No network destination is added:
// the listener is loopback-only and nothing is fetched from outside.
package localui

import (
	"os"
	"strings"
)

// Lang is one of "en" or "pt-BR".
type Lang string

const (
	LangEN   Lang = "en"
	LangPTBR Lang = "pt-BR"
)

// DetectLang picks the UI language from the environment (LC_ALL, LC_MESSAGES, LANG, LANGUAGE).
func DetectLang() Lang {
	for _, k := range []string{"LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"} {
		v := strings.ToLower(os.Getenv(k))
		if v == "" || v == "c" || v == "posix" {
			continue
		}
		if strings.HasPrefix(v, "pt") {
			return LangPTBR
		}
		return LangEN
	}
	return LangEN
}

// T returns the string for key in lang (falls back to English, then to the key).
func T(lang Lang, key string) string {
	if m, ok := strs[lang]; ok {
		if v, ok := m[key]; ok {
			return v
		}
	}
	if v, ok := strs[LangEN][key]; ok {
		return v
	}
	return key
}

var strs = map[Lang]map[string]string{
	LangEN: {
		"app":                 "Tunnelio",
		"pair.title":          "Pair a device",
		"pair.intro":          "Scan the QR code with your phone, or type the code in the web app under Devices → Enter pairing code.",
		"pair.code":           "Pairing code",
		"pair.expires":        "Expires in",
		"pair.expired":        "This code has expired.",
		"pair.none":           "No pairing in progress.",
		"pair.new":            "Generate a new code",
		"pair.openHere":       "Pair this device",
		"pair.openHereHelp":   "Opens the web app on this computer with the code pre-filled.",
		"pair.step1":          "On your phone, open the camera and point it at the QR code (or open the web app and sign in).",
		"pair.step2":          "Type the code if asked. Nothing is sent to the server: the code only proves you are in front of this computer.",
		"pair.step3":          "Done. That browser can now use the models on this computer, end-to-end encrypted.",
		"pair.cancel":         "Cancel pairing",
		"settings.title":      "Settings",
		"settings.server":     "Server address",
		"settings.serverH":    "The Tunnelio relay this computer connects to. Change it only if you self-host.",
		"settings.ollama":     "Ollama address",
		"settings.ollamaH":    "Where Ollama listens on this computer. Default is fine unless you changed Ollama's port.",
		"settings.name":       "Name of this computer",
		"settings.nameH":      "Shown in the web app's device list.",
		"settings.autostart":  "Start Tunnelio when I log in",
		"settings.autostartH": "Keeps your models reachable without opening the app by hand.",
		"settings.save":       "Save",
		"settings.saved":      "Saved.",
		"settings.restart":    "Saved. Quit and reopen Tunnelio to connect to the new server.",
		"settings.folder":     "Open the configuration folder",
		"status.title":        "Status",
		"status.ollama":       "Ollama",
		"status.relay":        "Relay",
		"status.paired":       "paired",
		"status.unpaired":     "not paired",
		"nav.pair":            "Pairing",
		"nav.settings":        "Settings",
		"nav.status":          "Status",
		"err":                 "Something went wrong:",
		"legal":               "Tunnelio © 2026 Thiago Bezerra Matias. Free software: you may share and change it under the GNU AGPL-3.0-only. It comes with no warranty. Its licence (LICENSE) and those of the software it includes (THIRD_PARTY_LICENSES.txt) come with the app.",
		"legal.license":       "License",
		"legal.source":        "Source code",
	},
	LangPTBR: {
		"app":                 "Tunnelio",
		"pair.title":          "Parear um dispositivo",
		"pair.intro":          "Escaneie o QR code com o celular, ou digite o código no app web em Dispositivos → Digitar código de pareamento.",
		"pair.code":           "Código de pareamento",
		"pair.expires":        "Expira em",
		"pair.expired":        "Este código expirou.",
		"pair.none":           "Nenhum pareamento em andamento.",
		"pair.new":            "Gerar um código novo",
		"pair.openHere":       "Parear este dispositivo",
		"pair.openHereHelp":   "Abre o app web neste computador com o código já preenchido.",
		"pair.step1":          "No celular, abra a câmera e aponte para o QR code (ou abra o app web e faça login).",
		"pair.step2":          "Digite o código se pedir. Nada vai para o servidor: o código só prova que você está na frente deste computador.",
		"pair.step3":          "Pronto. Esse navegador passa a usar os modelos deste computador, com criptografia de ponta a ponta.",
		"pair.cancel":         "Cancelar pareamento",
		"settings.title":      "Configurações",
		"settings.server":     "Endereço do servidor",
		"settings.serverH":    "O relay Tunnelio ao qual este computador se conecta. Mude só se você hospeda o seu próprio.",
		"settings.ollama":     "Endereço do Ollama",
		"settings.ollamaH":    "Onde o Ollama escuta neste computador. O padrão serve, a menos que você tenha mudado a porta do Ollama.",
		"settings.name":       "Nome deste computador",
		"settings.nameH":      "Aparece na lista de dispositivos do app web.",
		"settings.autostart":  "Iniciar o Tunnelio junto com o sistema",
		"settings.autostartH": "Mantém seus modelos acessíveis sem precisar abrir o app à mão.",
		"settings.save":       "Salvar",
		"settings.saved":      "Salvo.",
		"settings.restart":    "Salvo. Feche e abra o Tunnelio de novo para conectar ao novo servidor.",
		"settings.folder":     "Abrir a pasta de configuração",
		"status.title":        "Estado",
		"status.ollama":       "Ollama",
		"status.relay":        "Relay",
		"status.paired":       "pareado",
		"status.unpaired":     "não pareado",
		"nav.pair":            "Pareamento",
		"nav.settings":        "Configurações",
		"nav.status":          "Estado",
		"err":                 "Algo deu errado:",
		"legal":               "Tunnelio © 2026 Thiago Bezerra Matias. Software livre: você pode compartilhá-lo e modificá-lo sob a licença GNU AGPL-3.0-only. Não há garantia. A licença (LICENSE) e as do software que ele inclui (THIRD_PARTY_LICENSES.txt) vêm com o app.",
		"legal.license":       "Licença",
		"legal.source":        "Código-fonte",
	},
}
