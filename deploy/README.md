# deploy/ — self-host and production

| File | Use |
|---|---|
| `docker-compose.yml` | **Self-host**: one container, port 8080 on `127.0.0.1`, volume `/data` (SQLite; the web app ships inside the server image). Guide: "Self-hosting" in the root README. |
| `docker-compose.prod.yml` | **The production layout of tunnelio.app**: `nginx` (the **web app** + proxy), `tunnelio` (API/relay/admin), `db` (Postgres 16), `tunnel` (an optional outbound tunnel connector, so the server opens no ports; image and command from `.env.prod`) and `site` (the public site, built from a folder that is not part of this repository, `SITE_DIR`). |
| `docker-compose.local.yml` | Local rehearsal of the production layout (publishes nginx on :8090, the site on :8091). |
| `.env.prod.example` | Template for `.env.prod` (git-ignored). Next to it, `ln -s .env.prod .env` so that compose resolves `${…}`. |
| `nginx/` | Dockerfile (builds the web app and embeds it) and `templates/default.conf.template` (the admin path comes in through `ADMIN_URL_PATH`). The Django admin is **not** served on the public hostname: it sits in its own `server` on port 81, published only on `127.0.0.1:8081`, for a private network in front of it (for example `tailscale serve`). |
| `update.sh [all\|server\|nginx\|site]` | Runs **on the production server**, inside its clone of this repository already at the commit to deploy: database backup (not for the site alone; encrypted as below), `docker compose build` of the images from that clone (and of the site from its own checkout), `up -d`, waits until healthy, records the commits in a `DEPLOYED` log. |
| `backup-db.sh` | A **daily dump** of the production database, for a timer on the server: compressed and, when `../../backup-recipients.txt` (next to the clone) holds [age](https://age-encryption.org) public keys, encrypted to them, so the server writes dumps it cannot read and the private key stays with the operator; keeps the newest 30 (`BACKUP_KEEP`). Restore: `age -d -i KEY dump.sql.gz.age \| gunzip \| docker compose … exec -T db psql …`. |

## How production is deployed

The production server builds its images itself from **this repository**, at a commit whose tests
passed, so what runs at tunnelio.app is built from the published code:

1. A commit is deployed only once it is in this repository and its tests passed on a clean
   checkout of it (`scripts/check.sh`).
2. The server fetches that commit from this repository, which is public, over HTTPS: it needs no
   key or password for that, and it can only download.
3. `deploy/update.sh` backs up the database, builds the images, swaps the containers and waits
   until they are healthy. Every image carries the commit in its
   `org.opencontainers.image.revision` label, and publishes it at `/version.json` (next to the web
   app, never inside its bundle) and `GET /api/version`, so `scripts/verify-build.sh` can rebuild
   the web app from that commit and compare it with what is served (see "Verifying what
   tunnelio.app runs" in the root README).

The web app coexists with older trays through the capabilities each tray announces
(`device_info.capabilities`, SPEC §7.4): without `agents`, for example, the agents and skills screens
ask to update that computer.

> Pitfall: `docker compose restart` does **not** reload `env_file`; use `up -d <service>`.
