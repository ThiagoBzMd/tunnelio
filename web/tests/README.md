Vitest suites (`npm test -- --run`), under the `node` environment unless the file says `jsdom`:

- `vectors.test.ts` — loads `../../docs/vectors/vectors.json` and asserts every construction in
  `src/crypto` byte for byte (SPEC §13, V1–V6 and V8 = one-password login keys + pairings key; V7
  belongs to the retired cloud storage), plus SPAKE2 round-trips with random scalars and a
  wrong-code failure (side B lives only in the tests).
- `protocol.test.ts` — frame/message guards, both allowlists pinned, outbound validation, correlator timeouts.
- `relay.test.ts` — RelayClient over a fake WebSocket: hello/welcome, keepalive, backoff, close codes.
- `session.test.ts` — DeviceSession against a fake tray that runs the same crypto (handshake, MAC
  failure, counters, offline/online re-handshake, stalled streams).
- `pairing.test.ts` — pairDevice against a fake tray (side B of SPAKE2).
- `storage.test.ts` — in-memory and IndexedDB (fake-indexeddb) stores.
- `api.test.ts` — REST client against an in-memory Django-like server (cookies + CSRF).
- `stores.test.ts` — Zustand stores end to end (auth with derived keys: sign-up + e-mail code,
  two-step sign-in, reset by code, password change disconnecting the devices; unlocking the
  pairings with the password; devices; sessions; chat incl. image turns and the model memory rule;
  models incl. `supportsVision`; history incl. `images`, totals and delete-all; pairing sync and
  preferences sync across two "browsers" (merge, sign-out, password change, reset, a change left
  waiting by a reload, a change made during a sync); agents and skills on the computer and a chat
  with an agent; settings).
- `agents.test.ts` — `lib/agents.ts`: which skills go along (off / all / selected + the chat's), the
  system message, the 500-item cap with a system message, editing helpers, and the agent/skill
  checks of `validateOutbound` and the inbound guards.
- `documents.test.ts` — documents in the chat (SPEC §7.7): the `<document>` block format, file kinds,
  the model memory rule, every extractor against generated fixtures, how a message is composed.
- `conversations-settings.test.tsx` — Settings → Conversations rendered with React + jsdom against the
  fake tray: counts, size and Delete all on a current tray; the update hint on an older one; an
  offline computer.
- `images.test.ts` — DOM-free parts of `lib/images.ts`: standard base64 round-trip and length math,
  MIME sniffing by magic bytes, the pre-send size/encoding guard.
- `speech.test.ts` — `lib/speech.ts`: final/interim result merging and the `Dictation` wrapper
  against a fake recognizer.
- `cli.test.ts` — `scripts/interop-client.ts` as a child process against a real HTTP + `ws` fake server
  (sign-up with the mailed code, pairing + sync, chat, history, two-step sign-in, reset by code).
  The `agents` command runs against the real tray in `scripts/interop.sh`.
- `totp.test.ts` — the test-side TOTP (fake server + E2E) against the RFC 6238 SHA-1 vectors and
  RFC 4648 base32, so it agrees with real authenticator apps.
- `password.test.ts` — the client-side password policy (`src/lib/password.ts`).
- `sync.test.ts` — the synced-pairings document: wire shape, strict decoding, sealed form.
- `chat-ui.test.ts` — greeting (time of day, name from the e-mail) and sidebar helpers (date buckets
  by local day, accent-insensitive title search).
- `makers.test.ts` — model name → maker table (`src/lib/makers.ts`).
- `model-options.test.ts` — per-model settings: SPEC §8.3 ranges, input parsing, custom detection.
- `catalog.test.ts` — the Ollama library as relayed by the server: wire check, search, pull targets.
- `shell.test.ts` — links to the public site (derived from `app.<site>`), keyboard shortcuts, pinned
  conversations and the sidebar setting.
- `composer-hooks.test.tsx` — the composer's hooks rendered with React + jsdom: document drafts
  (reading → ready, removed/sent while reading → disposed on arrival, release on unmount) and the
  pre-send limits (scanned PDF blocks, figures warn, the model memory rule).
- `markdown.test.tsx` — assistant markdown: GFM without the highlighter; a fenced block keeps its
  text and gains highlight.js spans once the lazily loaded module arrives; unknown languages stay plain.

Helpers in `helpers/`: fake timers, fake WebSocket, fake relay/device (side B/D; the device keeps
agents and skills in memory and can pose as an older tray), fake REST server (verification/TOTP/reset
codes kept in `state.outbox`, `/api/devices/pairings`, `/api/auth/preferences`, `/api/auth/sessions`),
`totp.ts` (RFC 6238 codes for the fake server and the E2E).
