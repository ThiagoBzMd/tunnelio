// Package channel implements the encrypted application channel (SPEC §5–§7): session
// handshake, envelope seal/open with sequential nonces, and the dispatcher with the CLOSED
// allowlist of request types.
//
// Security invariants (verifiable by reading this package and enforced by .golangci.yml):
//
//   - The allowlist is ONE switch in dispatch.go: list_models, list_running, show_model,
//     chat, abort, pull_model, delete_model, history_list, history_get, history_delete,
//     history_clear, agent_list, agent_save, agent_delete, skill_list, skill_save,
//     skill_delete. Anything else is dropped and logged. No reply. The agent and skill
//     requests only read and write the history file; they never reach Ollama or the system.
//   - This package MUST NOT import os/exec, net, or net/http. It talks to Ollama only through
//     the typed methods of package ollama and to the relay only through package relay.
//   - Raw JSON from the browser is never forwarded: every request is decoded into a validated
//     struct (limits in SPEC §7.3, §8.2, §8.3) and re-encoded by package ollama. Chat images
//     are base64-decoded here, checked by magic bytes (JPEG/PNG/WebP/GIF), count and size, and
//     only then handed to package ollama as bytes and to package history as blobs.
//   - An envelope that fails authentication is discarded silently (SPEC §6.3).
//   - At most one chat and one pull per device at a time; 60 requests/min per session.
package channel
