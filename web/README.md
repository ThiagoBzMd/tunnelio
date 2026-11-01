# web/ — Tunnelio web app (React + TypeScript)

Single-page app served by nginx in production (`deploy/nginx/Dockerfile`) and by the server image
when self-hosted. All cryptography runs in the browser (WebCrypto + `@noble/curves` +
`@noble/hashes` + `hash-wasm`). License: **AGPL-3.0-only** (`LICENSE`).

```bash
nvm use            # Node 20
npm ci
npm run dev        # :5173, proxies /api and /ws to :8080 (scripts/devserver.sh start)
npm test           # vitest: vectors (V1–V6, V8), protocol, relay, session, pairing, stores, agents, images, documents, speech, CLI
npm run typecheck  # tsc over src + tests + scripts
npm run build      # → dist/ (typechecks src only), copied into the nginx and server images
npm run e2e        # Playwright against the real stack — use scripts/e2e.sh from the repo root
npm run interop -- <cmd>   # Node CLI: register | verify-email | login | pair --code | devices | models | chat | history | agents | totp-* | reset-*
```

## Layout

```
src/app/         App, router (auth guards keep /pair#CODE client-side), bootstrap, theme, relay hook
src/screens/     Login, Register, Verify e-mail, Forgot password, Chat, Devices (+ pair dialog), Models,
                 Agents, Skills (Settings is a window, not a screen)
src/components/  layout (AppShell, Sidebar, ScreenHeader, account menu), chat (Markdown, MessageList,
                 Composer, Pickers, ModelMenu, ToolsMenu), agents (editors, pickers), devices (PairDialog),
                 auth, settings (General / Account tabs), ui (shadcn)
src/i18n/        en + pt-BR dictionaries (`t()` / `useT()`), browser detection, persisted choice
src/crypto|protocol|relay|session|pairing|lib|stores   core layer (see src/README.md)
e2e/             Playwright full flow (mobile + desktop) with screenshots in e2e/screenshots/ (git-ignored)
```

Design: neutral monochrome theme (light/dark, system default), mobile-first, shadcn/ui + Lucide. The
layout is the familiar one of chat apps: a sidebar with the conversations, a central column with the
composer, menus and dialogs, in its own colours. The sidebar button at the top left docks the
sidebar or, unpinned, shows it floating while hovered (a drawer on phones). A new chat greets by
time of day and the name the person chose ("What should Tunnelio call you?", by default the e-mail
before @; serif: Source Serif 4, also used for the model's replies), with the composer in the middle
on desktop and at the bottom on phones; the composer has "+" (attach), the sliders button (agents
and skills), the microphone and a send button that only appears once there is something to send; the
computer (online dot), the thinking toggle and the model menu sit in a row under it. A chat with an
agent shows the agent's icon, name and description instead of the greeting. The ghost starts an
anonymous chat (the computer keeps nothing; the shell shows its own frame). The sidebar searches
titles across every computer, keeps pinned conversations on top and splits each computer's
conversations by date. Settings is a window with General and Account tabs; "Choose your language"
and "Keyboard shortcuts" are windows too (`src/components/settings/`, `src/components/layout/`).

Where things are kept: conversations, agents and skills on the computer (the tray's SQLite);
the person's preferences (theme, language, dictation, thinking, default model, per-model
settings, pinned chats, the name) sealed in the account with the password-derived key, so every
browser gets them (`src/stores/preferences-sync.ts`); the default computer, the sidebar pin and
the dictation notice in this browser only.

End-to-end acceptance without a browser (`scripts/interop-client.ts`, Node + `ws`):

```bash
npm run interop -- register --email you@example.com --password '…' --server http://localhost:8080
npm run interop -- pair --code K7M3-ABCD-EFGH        # code shown by the tray; stores PK in ./.tunnelio-cli.json
npm run interop -- devices
npm run interop -- models --device <device_id>
npm run interop -- chat --device <device_id> --model llama3.2:3b --prompt "Hi"
npm run interop -- history --device <device_id>
npm run interop -- agents --device <device_id> --model llama3.2:3b --prompt "Hi"   # save, use, delete an agent and a skill
npm run interop -- auth-key --email you@example.com --password '…'   # the derived key the server stores
```

`--state FILE` picks another state file (cookies + pairings, mode 0600); `--verbose` prints relay logs.

Screens: login/register · devices + pairing (12-symbol code or QR deep link `/pair#CODE`) ·
chat (streaming, device picker, anonymous chats via the ghost (nothing written on the computer),
thinking toggle for reasoning models, model menu with maker logos, per-model settings and the most
popular library models, agents and skills from the sliders button, clear offline state, image
attachments for vision models, documents, dictation through the browser's speech engine) · models
(list, loaded, pull with progress, delete with confirmation, the Ollama library with search and
capability filters) · agents (icon, name, description, model with its settings and thinking,
instructions, skills off / all / selected; "Use" starts a chat) · skills (list with filter; name,
category, when it applies, markdown instructions) · settings (General: theme, language, dictation,
conversations per computer; Account: the name, computers, active sessions with sign-out,
two-step sign-in, password change, account deletion).

Agents and skills (`src/stores/library.ts`, `src/lib/agents.ts`, SPEC §9.4) are read and written
on the chat's computer through the encrypted channel; a computer without the `agents` capability
gets a notice to update Tunnelio. The browser composes the system message (the agent's
instructions, then every active skill's whole text); the computer stores the agent and skills a
conversation used so reopening it applies them again.

Model makers (`src/lib/makers.ts`): the library family of a name is matched against a fixed table
(llama → Meta, gemma → Google, qwen → Alibaba…); the logos are SVGs from `@lobehub/icons-static-svg`
(MIT), only the ones in the table reach the bundle. Per-model settings (`src/lib/model-options.ts`,
SPEC §8.3 ranges) live in the settings store and follow the account. The library (`src/stores/catalog.ts`) comes
from `GET /api/catalog/ollama` and is cached for a day.

Images: attach / paste / drop up to 4 per message; each is decoded in the browser, downscaled to a
1568 px long edge and re-encoded (JPEG q0.85, PNG kept only with transparency) so it stays ≤ 4 MiB,
then travels as standard base64 inside the encrypted `chat` (8 MiB plaintext cap). The affordance
is enabled only when `device_info.capabilities` has `"images"` and `show_model` reports `"vision"`.
Dictation uses `SpeechRecognition` (Chrome sends audio to Google; Safari transcribes on device;
Firefox has none, so the button is hidden) — nothing goes through the relay.

Why React (not Svelte) and why not Open WebUI: `docs/SPEC.md` §14.7–14.8.
