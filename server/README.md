# server/ — Tunnelio relay and accounts (Django 5.2 + Channels 4)

One container, one port (8080), one volume (`/data`). Self-hosted, the image also serves the web
app; in production nginx serves the web app, Postgres holds the data and this container only
answers the API, the relay and the admin (`deploy/README.md`). License: **AGPL-3.0-only** (`LICENSE`).

| App | Responsibility | SPEC |
|---|---|---|
| `accounts` | email + password (Argon2), cookie sessions and the active-sessions list (browser/system only, sign out one or all), account deletion | §10.5, §11.1–11.2 |
| `devices` | device registry, user-approved pairing sessions, online/offline | §3, §4, §11 |
| `pairings` | one opaque blob per account: the browser-side pairing secrets, encrypted with a key derived from the password (REST only) | §10.2 |
| `preferences` | the account's preferences as one opaque blob sealed in the browser (theme, language, pinned chats, the name to be called by…) | §10.5 |
| `relay` | Channels consumers: receive frame from A, deliver to B. Zero logic. Agents, skills and conversations travel inside the encrypted payload like everything else. | §3, `relay/README.md` |
| `catalog` | the public Ollama library list, fetched daily by `refresh_ollama_catalog` (entrypoint), with each model's download sizes from its own page, and served at `/api/catalog/ollama`; bundled snapshot in `catalog/data/` | §11.1–11.2 |

The server **never** implements channel cryptography. It knows exactly what SPEC §1.3 lists.

## Run locally

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements/dev.txt
python manage.py migrate        # SQLite in server/data; no variables needed (all of them: .env.example)
make -C .. dev-server           # uvicorn --reload on :8080
```

## Container

```bash
docker build -f Dockerfile -t tunnelio-server:dev ..      # from server/; the context is the repository root
docker run -d -p 8080:8080 -v tunnelio-data:/data -e SECRET_KEY=… -e ALLOWED_HOSTS=… tunnelio-server:dev
```

Defaults: SQLite in `/data` + `InMemoryChannelLayer` (`UVICORN_WORKERS=1`). `DATABASE_URL` →
Postgres; `REDIS_URL` → `channels_redis` and `UVICORN_WORKERS>1` allowed. Admin at
`/$ADMIN_URL_PATH/` (keep it off the public hostname: the production example serves it only on a
loopback port for a private network). The entrypoint runs the migrations and refreshes the Ollama library at start and daily.
All variables: `.env.example`.

## Tests

```bash
pytest            # settings: tunnelio.settings.test (SQLite :memory:, in-memory layer); also `make test-server`
ruff check .
ruff format --check .
```
