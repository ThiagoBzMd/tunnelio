# tray/ — Tunnelio tray app (Go)

System-tray app that keeps an **outbound** WebSocket to the relay and talks **only** to the
local Ollama. License: **AGPL-3.0-only** (`LICENSE`). Module: `github.com/ThiagoBzMd/tunnelio/tray`.

## Layout and invariants

```
cmd/tunnelio/        main + app_*.go (pairing, relay, status, menu actions); defaultServerURL + version
                     injected via -ldflags (no hostname in source)
internal/channel/    E2E channel: handshake, envelopes, CLOSED allowlist dispatcher, chat, pull,
                     agents and skills (library.go)                                 (no os/exec, no net)
internal/crypto/     SPAKE2-P256 (RFC 9382), X25519+HKDF session keys, AES-GCM envelope, Crockford code
internal/ollama/     typed client — one method per fixed endpoint; validated structs; loopback only
internal/relay/      outbound WebSocket, auth, keepalive 30 s, backoff w/ jitter, close codes
internal/pairing/    device side (B) of SPAKE2 pairing
internal/history/    the computer's SQLite file (modernc, WAL, schema v4): conversations, messages,
                     images, agents and skills, agent chains and their earlier answers
internal/localui/    local pages on 127.0.0.1 with a per-run token: pairing (code, QR, instructions)
                     and settings, opened from the menu
internal/tray/       systray menu + notifications — the ONLY surface for system actions
internal/system/     the ONLY package allowed to import os/exec (Ollama start, autostart, open URL)
internal/release/    compares this build's version with the newest release the relay announces
internal/config/     files under os.UserConfigDir()/tunnelio (0600 for secrets)
packaging/           MSIX manifest, macOS bundle, Linux desktop file and icons
assets/              icons generated from brand/
```

The tray's security rules map to code like this (see each package's `doc.go`):

| Rule | Where it is verifiable |
|---|---|
| 1 closed allowlist (`list_models`, `list_running`, `show_model`, `chat`, `abort`, `pull_model`, `delete_model`, `history_list`, `history_get`, `history_delete`, `history_clear`, `agent_list`, `agent_save`, `agent_delete`, `skill_list`, `skill_save`, `skill_delete`) | single `switch` in `internal/channel/dispatch.go`; changing it changes the protocol (`docs/SPEC.md` §7) |
| 2 one type → one fixed Ollama endpoint (or the local history file), validated structs | `internal/ollama` exported methods; no generic request |
| 3 `pull_model` strict name + local notification | `internal/ollama` regex + `internal/tray` notify |
| 4 no `os/exec` in channel; only two network destinations | `.golangci.yml` depguard + imports test |
| 5 system actions only from the local menu | `internal/system` is called only by `internal/tray` |
| 6 no tool calling | `tools` never sent; `tool_calls` rendered as text |
| 7 undecryptable message dropped | `internal/channel` envelope open |
| 8 one chat at a time, size + rate limits | `internal/channel` |
| 9 Ollama detection states | `internal/system` + `/api/version` |
| 10 autostart opt-in | `internal/system` + first-run prompt |
| 11 `fyne.io/systray` | `internal/tray` |

## Build

```bash
go build ./cmd/tunnelio                 # Linux/Windows: CGO_ENABLED=0 (systray is pure Go there)
CGO_ENABLED=1 go build ./cmd/tunnelio   # macOS (systray uses Cocoa)
go build -tags headless ./cmd/tunnelio  # any OS, CGO off: no systray at all (servers, CI, cross-builds)
go test ./...                           # includes docs/vectors/vectors.json checks + the import-rule test
golangci-lint run ./...                 # depguard = the security rules
```

Cross-checks that must stay green: `GOOS=windows CGO_ENABLED=0 go build ./cmd/tunnelio`,
`GOOS=darwin CGO_ENABLED=0 go vet $(go list ./internal/... | grep -v /internal/tray)` and
`GOOS=darwin CGO_ENABLED=0 go vet -tags headless ./...` (only `internal/tray` needs CGO, and only
on macOS). Requires Go 1.26+ (`modernc.org/sqlite`).

`go test ./internal/ollama/` also runs an integration test against a real Ollama at
`$TUNNELIO_OLLAMA_URL` (default `http://127.0.0.1:11434`); it is skipped when Ollama is not
reachable. When `moondream` is installed it additionally sends a generated PNG to exercise
`chat.messages[].images` (vision).

## Run

```
tunnelio [--headless] [--config-dir DIR] [--server URL] [--ollama URL] [--pair] [--version]
```

| Setting | Flag | Env | File |
|---|---|---|---|
| Config directory | `--config-dir` | `TUNNELIO_CONFIG_DIR` | default `os.UserConfigDir()/tunnelio` |
| Relay server | `--server` | `TUNNELIO_SERVER_URL` | `config.json: server_url` (fallback: `-X main.defaultServerURL`) |
| Ollama | `--ollama` | `TUNNELIO_OLLAMA_URL` | `config.json: ollama_url` (loopback only unless `allow_non_loopback_ollama`) |
| Headless | `--headless` | `TUNNELIO_HEADLESS=1` | — |
| Log level | — | `TUNNELIO_LOG_LEVEL=debug` | — |

Files: `config.json` (settings, no secrets), `device.json` (device_id + token, 0600),
`pairings.json` (pairing_id → PK, 0600), `history.sqlite` (conversations, agents and skills, WAL,
0600; not encrypted, protected by the system account). On Linux and macOS the folder is kept at
0700, and a folder or file left open to other accounts by an older version is closed on start.
Opening an older `history.sqlite` migrates it in place (v1 → v4 adds tables and columns only); a
file written by a newer version is refused rather than misread.

**Headless mode** (no tray; logs to stdout) is for servers and tests. When the device is not
paired yet (no `device.json`) it starts a pairing automatically — also with `--pair` — and prints
these stable marker lines on stdout, one per line:

```
RELAY connected
PAIRING CODE: XXXX-XXXX-XXXX          # type it in the browser (claim + secret)
PAIRING OK | PAIRING FAILED: <reason>  # after a failure while unpaired, a new code follows in 5 s
PAIRED device_id=<uuid>                # first pairing only; device.json written
SESSION <client_id> opened
SESSION <client_id> handshake ok
SESSION <client_id> closed reason=<r>
RELAY disconnected code=<n>
UNPAIRED reason=<r>                    # close 4001 / revoked: device.json deleted
```

**Tray mode** menu: status, "Pair a device" (opens the local pairing page with the code, a QR
code and the instructions; the code also shows in the menu), start Ollama / download Ollama,
settings (local page), start at login (opt-in; a one-time notification points to it on first
run), forget the paired browsers, unlink this computer, quit. Autostart is never touched in
headless mode.

Releases: a `vX.Y.Z` tag runs `.github/workflows/release-tray.yml`: GoReleaser on Ubuntu
(`.goreleaser.yaml`: `Tunnelio-ubuntu.deb` and `Tunnelio-windows.zip`, amd64 and arm64), GoReleaser on
macOS (`.goreleaser.darwin.yaml`: universal `Tunnelio-macos.dmg`) and an MSIX kept as a workflow
artifact for the Microsoft Store. File names carry no version, so `releases/latest/download/<name>`
is a permanent link. `-rc.N` tags are pre-releases. Builds stay unsigned until the signing
certificates exist.
