"""
catalog — the public list of models from the Ollama library (ollama.com/library), fetched once a
day by `manage.py refresh_ollama_catalog` (entrypoint.sh) and served to the web app at
`GET /api/catalog/ollama` (SPEC §11.2). One row per source; the bundled JSON under `data/` is the
fallback until the first fetch succeeds. Nothing here is about a user: the server only relays a
public page, in a shape the browser can filter.
"""

from __future__ import annotations

from django.db import models


class OllamaCatalog(models.Model):
    key = models.CharField(primary_key=True, max_length=32, default="ollama")
    source_url = models.URLField()
    fetched_at = models.DateTimeField()
    data = models.JSONField()  # list of entries, see catalog.library.parse_library
    count = models.PositiveIntegerField()

    class Meta:
        db_table = "catalog_ollama"

    def __str__(self) -> str:
        return f"{self.key}: {self.count} models at {self.fetched_at:%Y-%m-%d %H:%M}"
