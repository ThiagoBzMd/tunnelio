# Legal

This page gathers everything legal about this repository. If anything here and the files it points
to disagree, those files win: [`LICENSE`](LICENSE) for the code, [`TRADEMARKS.md`](TRADEMARKS.md)
for the name and the logo, [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for other people's
software, and [`CONTRIBUTING.md`](CONTRIBUTING.md) for contributions.

## Copyright

Copyright © 2026 Thiago Bezerra Matias.

## Licence: GNU AGPL-3.0-only

Everything in this repository is licensed under the **GNU Affero General Public License, version 3
only** (SPDX: `AGPL-3.0-only`). That covers the computer app (`tray/`), the web app (`web/`), the
server (`server/`), the protocol specification and its test vectors (`docs/`), the build and deploy
files, the scripts and the brand files. The only exceptions are files that come from other people
and keep their own licences, and the facts about Ollama's models (see
[Third-party software](#third-party-software)). The brand files are licensed like the rest, as
files; the licence grants no trademark rights (see [The name and the logo](#the-name-and-the-logo)).
Each component carries a copy of the licence: [`LICENSE`](LICENSE), [`tray/LICENSE`](tray/LICENSE),
[`web/LICENSE`](web/LICENSE) and [`server/LICENSE`](server/LICENSE), all the same text.

"Version 3 only" means this exact version of the licence, not later ones, unless the copyright
holder decides otherwise for future releases.

### In plain words

This summary is no substitute for the licence. Where they differ, the licence applies.

- **You may** use Tunnelio for any purpose, commercial included. You may study how it works, change
  it, run it, and share it, in its original or modified form.
- **If you give copies to others**, as source or as built programs, modified or not, you must:
  - keep the licence and the copyright and licence notices;
  - license your version, as a whole, under the AGPL-3.0;
  - give the people who receive it the complete corresponding source code of what you gave them
    (sections 4–6). That includes the scripts used to build and install it.
- **If you modify it and other people use your modified version over a network**, for example a
  changed server or web app offered as a service, you must offer those users the source code of your
  version. Do it from the program itself, at no charge (section 13). This is what the "Affero" adds
  to the GPL: a modified copy cannot be kept closed just because it runs on a server.
- **Changes you keep to yourself** carry no obligation to publish them. That means you do not give
  copies to anyone, and nobody else uses your version over a network.
- **You may not** add restrictions of your own to what you pass on (section 10). You also cannot
  sue anyone over patents in it and keep the licence (sections 10–11).
- **There is no warranty and no liability.** The software is provided "as is", to the extent the law
  allows (sections 15–17).

### Why the AGPL

Tunnelio's promise is that the relay cannot read your conversations, and anyone can check that only
because the code is open. The AGPL keeps it that way. Every version that others derive from this
code, including one offered as a service, stays open to the people who use it: nobody can take a
copy closed. Only the copyright holder can also offer the code under other terms (see
[Contributions](#contributions)).

## The name and the logo

"Tunnelio" and its logo are trademarks. The licence covers the logo's files like any other file in
the repository, but it grants no rights under trademark law to the name or the logo (section 7(e) of
the AGPL). Unmodified copies, truthful references ("based on Tunnelio") and private use, inside an
organisation too, are fine, and so is keeping the name where the licence or compatibility needs it
(the copyright notices, code and protocol identifiers). A modified version that you distribute, or
offer as a service to people outside your organisation, needs a name and a logo of its own. The full
rules are in [`TRADEMARKS.md`](TRADEMARKS.md).

## Third-party software

Tunnelio is built on other people's work: libraries for Go, Python and the browser, two fonts and
icon sets. Some components are copied into this repository, such as the user-interface building
blocks from shadcn/ui in `web/src/components/ui/`. They keep their own licences, all of which allow
them to be distributed with Tunnelio under the AGPL-3.0, and their notices must travel with them.
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) describes what each part we distribute contains
and under which licences. The full texts, with each component's version and copyright, are generated
when each part is built and travel inside it: the web app, every package of the computer app, and
the server image.

The list of models in `server/catalog/data/` holds facts taken from the public library at
ollama.com: names, labels, sizes, counts and dates. It does not keep ollama.com's descriptions.

Model names and the makers' logos in the web app (Meta, Google, Mistral…) belong to their owners.
They appear only to say which maker a model comes from.

## Contributions

Contributions are welcome. By sending one you license it under the AGPL-3.0-only. You also grant
the copyright holder the right to offer it under other terms, so the project keeps a single owner of
its licensing. You keep the copyright of your work. The exact terms and the sign-off are in
[`CONTRIBUTING.md`](CONTRIBUTING.md); a contribution whose author cannot accept them is not merged.

## The hosted service at tunnelio.app

The code and the service are separate things. The service at [tunnelio.app](https://tunnelio.app) is
run by Thiago Bezerra Matias, an individual developer in Brazil. It is governed by its own
[Terms of service](https://tunnelio.app/terms.html),
[Privacy policy](https://tunnelio.app/privacy.html) and
[Usage policy](https://tunnelio.app/usage-policy.html), in English and in Portuguese. The licence of
the code does not oblige anyone to provide that service. Anyone may run their own server instead
(see "Self-hosting" in the [README](README.md)).

## Cryptography

This software contains cryptography: SPAKE2 pairing, X25519 key agreement, AES-256-GCM encryption,
the Argon2id and HKDF key derivations, and TLS through the libraries it uses. Some countries restrict
the import, possession, use or re-export of encryption software. Check the laws where you are before
you use, build or redistribute it.

## Contact

- General and legal questions: [hello@tunnelio.app](mailto:hello@tunnelio.app).
- Security vulnerabilities: privately, as described in [`SECURITY.md`](SECURITY.md). Never in a
  public issue.
