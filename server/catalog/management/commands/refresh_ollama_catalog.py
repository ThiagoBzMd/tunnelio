"""
`manage.py refresh_ollama_catalog` — fetch ollama.com/library, parse it and store the model list
for `GET /api/catalog/ollama`. The entrypoint runs it at start and once a day. A page that yields
fewer than --min-models entries (a redesign, an error page) is rejected and the previous list stays.

Then the download sizes (rev. 1.9): each model's own page lists its tags with their size. Only the pages
of models that are new, or that the library updated since the last run, are read, one per second
(the whole library, the first time: about four minutes); the others keep the sizes they had. The
list is stored before the pages are read, and again as their sizes come in.

    --from-file PATH   parse a saved page instead of fetching (tests, offline: the model pages then
                       come only from --pages-from)
    --pages-from DIR   read the model pages from DIR/<name>.html instead of fetching them
    --no-sizes         skip the model pages (the sizes already known are kept)
    --snapshot PATH    also write the list as JSON (the bundled fallback under catalog/data/)
    --no-db            parse only (with --snapshot: regenerate the bundled file)
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from catalog.library import (
    PAGE_DELAY_S,
    carry_sizes,
    fetch_library,
    fetch_model_page,
    load_snapshot,
    parse_library,
    read_sizes,
    write_snapshot,
)
from catalog.models import OllamaCatalog


class Command(BaseCommand):
    help = "Fetch the Ollama library page and store the model list served at /api/catalog/ollama."

    def add_arguments(self, parser):
        parser.add_argument("--url", default=settings.OLLAMA_LIBRARY_URL)
        parser.add_argument("--from-file", help="parse this saved HTML page instead of fetching")
        parser.add_argument("--pages-from", help="read the model pages from DIR/<name>.html instead of fetching")
        parser.add_argument("--no-sizes", action="store_true", help="do not read the model pages")
        parser.add_argument("--snapshot", help="also write the list as JSON to this path")
        parser.add_argument("--no-db", action="store_true", help="do not store the list in the database")
        parser.add_argument("--min-models", type=int, default=50, help="reject a page with fewer entries")

    def handle(self, *args, **opts):
        source = opts["url"]  # recorded as the source even for a saved copy of that page
        if opts["from_file"]:
            page = Path(opts["from_file"]).read_text(encoding="utf-8")
        else:
            try:
                page = fetch_library(source)
            except Exception as exc:  # network, HTTP, size: all leave the previous list in place
                raise CommandError(f"fetch failed: {exc}") from exc
        models = parse_library(page)
        if len(models) < opts["min_models"]:
            raise CommandError(f"only {len(models)} entries parsed (minimum {opts['min_models']}); keeping the previous list")
        fetched_at = datetime.now(UTC)

        row = None if opts["no_db"] else OllamaCatalog.objects.filter(key="ollama").first()
        stale = carry_sizes(models, row.data if row else load_snapshot().get("models", []))

        def store() -> None:
            if not opts["no_db"]:
                OllamaCatalog.objects.update_or_create(
                    key="ollama",
                    defaults={"source_url": source[:200], "fetched_at": fetched_at, "data": models, "count": len(models)},
                )

        store()
        self.stdout.write(f"{len(models)} models from {source}")

        pages = opts["pages_from"]
        if not opts["no_sizes"] and stale and (pages or not opts["from_file"]):
            if pages:
                folder = Path(pages)
                read, failed = read_sizes(stale, lambda name: (folder / f"{name}.html").read_text(encoding="utf-8"), delay=0)
            else:
                read, failed = read_sizes(
                    stale, lambda name: fetch_model_page(source, name), delay=PAGE_DELAY_S, on_progress=store
                )
            store()
            self.stdout.write(f"download sizes: {read} model pages read, {failed} failed, {len(models) - len(stale)} unchanged")
        if opts["snapshot"]:
            write_snapshot(Path(opts["snapshot"]), source, fetched_at, models)
