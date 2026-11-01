// Package relay maintains the outbound WebSocket to the configured server (SPEC §3):
// hello/welcome, device token auth, pairing frames, session_open/closed, data forwarding,
// ping every 30 s, exponential backoff with full jitter (1 s → 60 s), and close-code handling
// (4001 revoked → forget device; 4006 replaced). It carries opaque payloads for package
// channel and package pairing and never inspects them.
//
// Besides ollama (the local Ollama) and localui (the app's page on the loopback address), it is the
// only package that imports net/http (to dial) — see .golangci.yml.
package relay
