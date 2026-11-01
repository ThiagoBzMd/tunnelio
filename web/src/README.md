# web/src — layout

```
crypto/      SPEC §2.1, §4–§6 — bytes/b64url helpers, Crockford code (+check symbol), pairing
             code → w, SPAKE2-P256 side A (@noble/curves), PK/pairing_id, session keys (x25519 +
             HKDF), AES-GCM envelope (WebCrypto), auth (one password: Argon2id master → auth_key
             sent to the server + pairings_key that never leaves the browser, vector V8), sync
             (the sealed pairings and preferences blobs, one AAD each), uuid. Pure, no DOM;
             byte-exact against docs/vectors/vectors.json.
protocol/    Types + guards for relay frames (§3.3), handshake/envelope payloads (§5.1, §6.1),
             SPAKE2 messages (§4.4), channel requests/responses with both allowlists (§7, agents
             and skills included); constants/limits/timeouts, request ids, injectable timers,
             request/stream correlator.
relay/       RelayClient for /ws/client: hello/welcome, open/close, data, pair_*, device_status,
             ping 30 s / dead 45 s, full-jitter backoff 1→60 s, close-code handling. Injectable
             WebSocket constructor (browser WebSocket or Node `ws`) and timers. Typed events.
session/     DeviceSession: per-device E2E state machine (open → hello → hello_ack → confirm →
             device_info), encrypted request/stream/pull with strict counters, offline/online
             re-handshake, needs-pairing detection.
pairing/     pairDevice(): side A of the SPAKE2 pairing over pair_* frames, 60 s per step.
lib/         api.ts (fetch + cookies + CSRF, every REST endpoint of §11.2: sign-up with e-mail code,
             two-step sign-in, password reset by code, devices, synced pairings and preferences,
             active sessions), storage.ts (pairings, session key and settings: IndexedDB via idb,
             or in-memory), images.ts (attachment prep: decode → ≤ 1568 px → JPEG/PNG → standard
             base64), documents/ (PDF, Word, spreadsheets and text read in the browser, §7.7),
             context.ts (the model memory rule → num_ctx), agents.ts (which skills apply, the
             system message, editing helpers), agent-icons.tsx (the agent icon gallery and skill
             categories), makers.ts, model-options.ts, catalog.ts, speech.ts (dictation),
             password.ts (client-side policy), site.ts (links to the public site), shortcuts.ts.
stores/      Zustand (vanilla, Node-compatible): auth (derives the login keys; keeps the pairings key
             for the session; e-mail verification, two-step sign-in, reset by code, the disconnect
             after a password change), devices (REST list is authoritative), sessions, chat
             (agent, skills and system message per turn), models, history (the tray's SQLite
             through the channel), library (agents and skills of each computer), catalog (the
             Ollama library, cached a day), settings (the working copy of the preferences),
             pairing-sync and preferences-sync (sealed blobs in the account: merge, import, push;
             changes not yet pushed survive a reload), ui (open windows, drafts); runtime injection
             (configureRuntime), wiring (wireStores/startApp/loadAccount), React hooks in react.ts.
screens/     login (+ two-step code), register, verify e-mail, forgot password (code), devices +
             pairing (+ the "disconnected" notice), chat, models, agents, skills.
components/  shadcn/ui primitives; layout (shell, sidebar, account menu, shortcuts); chat thread
             (markdown; the code highlighter loads on the first fenced block), composer (thin
             component over `chat/composer/`: attachments, documents, dictation, draft limits, file
             drop + the toolbar pieces), pickers, model menu, the agents and skills menu
             (ToolsMenu + useChatAgent); agents (editors, icon and skill pickers); settings window
             (General and Account tabs: profile name, computers, active sessions, security).
```

Stack: React 19, Vite 7, TypeScript 5, Tailwind v4, shadcn/ui (radix-ui), Zustand, React Router 7.
Crypto never touches the server: the server only ever sees ciphertext (SPEC §1) and a derived auth
key instead of the password. Conversations, agents and skills live on the user's computer only.
