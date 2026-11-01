# Contributing to Tunnelio

Thank you for wanting to help. Tunnelio is maintained by one person, so a little preparation goes a
long way: it keeps your work from being wasted, and it keeps the project's promise intact. That
promise is a relay that cannot read your conversations.

## Ways to help

- **Report a bug**: open an issue with the "Bug report" form. Include the build of the web app
  (Settings → General → Build), the version of the computer app (its tray menu), your system,
  your browser and your Ollama version.
- **Suggest an improvement**: open an issue with the "Feature request" form, and describe the problem
  before the solution.
- **Report a vulnerability**: **never** in a public issue. Follow [`SECURITY.md`](SECURITY.md).
- **Send code, documentation or translations**: read the rest of this page first.

## Before you write code

Open an issue first for anything larger than a small fix, so we can agree on the approach. Some
parts of the design are deliberate limits, and a pull request that crosses them cannot be accepted,
however good the code. The design rules below can be checked in the code:

1. **The server never touches the encryption.** Only the computer app (`tray/`) and the web app
   (`web/`) implement SPAKE2, X25519 and AES-GCM. The relay forwards `payload` without reading it.
2. **A closed list of requests.** The computer app accepts only the request types listed in
   [`docs/SPEC.md`](docs/SPEC.md) §7. Anything else is dropped and logged. A new type is a design
   decision, so discuss it in an issue first.
3. **One request type, one fixed destination**: one Ollama endpoint, with validated structures and
   never raw JSON, or the computer's own history file. `/api/create`, `/api/push` and `/api/copy`
   do not exist in the client.
4. **Narrow imports.** `os/exec` only in `tray/internal/system`. The packages that handle what
   arrives through the relay, the keys and the history (`internal/channel`, `crypto`, `history`,
   `pairing`) never import `net` or `net/http`. The network lives in `internal/ollama` (the local
   Ollama), `internal/relay` (the outgoing WebSocket) and `internal/localui` (the app's own page,
   on the loopback address only). The linter (`depguard`) and `tray/internal/imports_test.go`
   enforce these rules.
5. **System actions only from the computer.** Starting Ollama, autostart and ports are only in the
   tray's local menu, never in a remote request.
6. **No secrets, hostnames or tokens in the code.** All configuration comes from the environment.
   `.env.example` files list the variables.
7. **The admin never shows sealed contents**, only sizes and dates, and never token hashes.
8. **The protocol has a contract.** A change to the wire format or to the cryptography goes into
   [`docs/SPEC.md`](docs/SPEC.md). If it changes the test vectors, regenerate them with
   `make vectors` (never edit `docs/vectors/vectors.json` by hand) and bump their version. Both
   implementations, Go and TypeScript, must keep passing them.

## Setting up

Prerequisites: Go (the version in `tray/go.mod` or newer), Python 3.12, Node 20 (`.nvmrc`), Docker,
and Ollama if you want the tests that talk to a real model. The Make targets and the scripts also
expect a virtual environment in `server/.venv` with `server/requirements/dev.txt`, golangci-lint v2,
and, for `scripts/e2e.sh`, Playwright's Chromium (the README's "Development" section has the
commands).

```bash
make help                 # every target
make test                 # unit tests: server (pytest), tray (go test), web (vitest)
scripts/check.sh          # everything the CI workflow runs: vectors, server, web, tray, interop
scripts/interop.sh        # a real server, a headless tray and the Node client against each other
scripts/e2e.sh            # Playwright on phone and desktop sizes, with screenshots
```

Each component's README has more: [`tray/`](tray/README.md), [`server/`](server/README.md),
[`web/`](web/README.md). How everything is tested: the "Development" section of the
[README](README.md).

## Pull requests

- **Keep each one small and focused**: one change, with tests, and the documentation updated with it.
- **Everything in English**: code, comments, documentation and commit messages. The product's own
  translations are the exception (for example `web/src/i18n/pt-BR.ts` and the tray's locale
  strings).
- **Conventional Commits**: for example `feat(tray): …`, `fix(server): …`, `docs: …`.
- **The checks pass**: `scripts/check.sh` (ruff, ESLint with `tsc`, golangci-lint, and the tests).
  GitHub does not run them on pull requests, so run them before you open one.
- **Sign off every commit** (`git commit -s`), as described below.

## Licensing of contributions

By sending a contribution (code, documentation, translations or any other material) to this project,
you agree to the following:

1. **Origin.** The contribution is your own work, or you have the right to submit it under these
   terms. You certify the [Developer Certificate of Origin 1.1](https://developercertificate.org) by
   adding a `Signed-off-by: Your Name <you@example.com>` line to each commit (`git commit -s` does
   it).
2. **Licence.** The contribution is licensed under the GNU AGPL-3.0-only, the licence of this
   repository.
3. **An additional grant to the copyright holder.**
   - **Copyright.** You grant Thiago Bezerra Matias, and anyone to whom the project is transferred, a
     perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable licence. It covers
     using, reproducing, modifying, publicly displaying, sublicensing and distributing your
     contribution, and works based on it, under the AGPL-3.0 or under any other terms, commercial
     licences included.
   - **Patents.** You grant a patent licence on the same terms, for any patent claims of yours
     that your contribution necessarily infringes.
   - **Why.** This keeps the project's licensing in one hand. It can then move to a later licence or
     offer a separate licence without having to find every contributor again.
4. **You keep your copyright.** Nothing here transfers ownership, and you may use your contribution
   elsewhere as you like.
5. **No warranty.** You provide your contribution "as is", unless you state otherwise in writing.

If you cannot agree to point 3 (for example, your employer owns your work and does not allow it),
say so in the pull request. It will then not be merged, since point 3 applies to every merged
contribution; you are still welcome to describe the problem or the idea in an issue.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report problems to
[hello@tunnelio.app](mailto:hello@tunnelio.app).
