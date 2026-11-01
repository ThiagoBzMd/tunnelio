# Tunnelio — development shortcuts (one monorepo, three components).
# Uses '>' as the recipe prefix (no TAB required).
.RECIPEPREFIX := >
.PHONY: help dev-server dev-web dev-tray test test-server test-web test-tray lint vectors docker-build docker-run

help: ## List the commands
> @grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ── Development ──────────────────────────────────────────
dev-server: ## Django at http://localhost:8080 (SQLite + InMemoryChannelLayer)
> cd server && . .venv/bin/activate && DJANGO_SETTINGS_MODULE=tunnelio.settings.dev python -m uvicorn tunnelio.asgi:application --reload --port 8080

dev-web: ## Vite at http://localhost:5173 (proxies /api and /ws to :8080)
> cd web && npm run dev

dev-tray: ## Tray pointed at the local server
> cd tray && TUNNELIO_SERVER_URL=http://localhost:8080 go run ./cmd/tunnelio

# ── Tests ───────────────────────────────────────────────────
test: test-server test-web test-tray ## Everything

test-server: ## pytest
> cd server && . .venv/bin/activate && python -m pytest -q

test-web: ## vitest (includes the vectors)
> cd web && npm test -- --run

test-tray: ## go test (includes the vectors and the imports test)
> cd tray && go test ./...

lint: ## ruff + eslint/tsc + golangci-lint
> cd server && . .venv/bin/activate && ruff check .
> cd web && npm run lint && npx tsc --noEmit
> cd tray && golangci-lint run ./...

vectors: ## Regenerate docs/vectors/vectors.json (aborts if the RFC 9382 vector does not match)
> cd docs/vectors && python3 gen_vectors.py

# ── Docker ───────────────────────────────────────────────────
docker-build: ## Build the server image (includes the SPA build)
> docker build -f server/Dockerfile -t tunnelio-server:dev .

docker-run: ## Run the local image on :8080 with the tunnelio-data volume
> docker run --rm -p 8080:8080 -v tunnelio-data:/data -e SECRET_KEY=dev-only -e ALLOWED_HOSTS=localhost,127.0.0.1 tunnelio-server:dev
