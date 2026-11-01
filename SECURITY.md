# Security

Tunnelio's promise is that the relay server cannot read your conversations. Everything between the
browser and your computer is end-to-end encrypted: SPAKE2 pairing, X25519 sessions, AES-256-GCM.
The computer accepts only a closed list of request types. The design, its limits and what the server
does know are in [`docs/SPEC.md`](docs/SPEC.md) §1.3 and §1.4.

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on this repository. If that
is not possible, write to [hello@tunnelio.app](mailto:hello@tunnelio.app). **Do not open a public
issue.**

Please include:

- what you found and where (component, file, version or build);
- how to reproduce it, step by step;
- what an attacker could do with it, and under which conditions.

You will get an answer, usually within a few days. You will hear how the issue is being handled, and
get credit in the release notes if you want it, once a fix is out. Please give a reasonable time for
the fix before you disclose the issue publicly. We will agree on a date together.

## Supported versions

Fixes go into the latest release of the computer app and into the code running at tunnelio.app. If
you run an older release or your own server, update to the latest release.

## Scope

**In scope:**
- the computer app (`tray/`);
- the relay and accounts server (`server/`);
- the web app (`web/`);
- the protocol itself ([`docs/SPEC.md`](docs/SPEC.md));
- the build and release pipeline in this repository.

**Out of scope:**
- attacks that need control of the user's own computer or browser;
- denial of service by sheer volume;
- reports from automated scanners with no demonstrated impact;
- social engineering of people.

## Testing in good faith

Prefer your own server (see "Self-hosting" in the [README](README.md)) or your own account. Never
access, change or keep other people's data. Do not degrade the service for others, and stop and
report as soon as you find a problem.

If you follow this policy in good faith, we will consider your research authorised, work with you to
understand and fix the issue, and take no legal action against you for it. This covers only the
systems this project runs (tunnelio.app and its subdomains) and your own installations: we cannot
authorise tests against anyone else's systems, such as the services the project uses for hosting,
e-mail or code.
