"""
GET /api/catalog/ollama — the model list of the Ollama library, as last fetched (or the bundled
snapshot before the first fetch). Signed-in users only (it is not a public mirror); an hour of
browser caching is plenty for a daily list.
"""

from __future__ import annotations

from rest_framework.response import Response
from rest_framework.views import APIView

from .library import load_snapshot
from .models import OllamaCatalog


class OllamaCatalogView(APIView):
    throttle_scope = "catalog"

    def get(self, request):
        row = OllamaCatalog.objects.filter(key="ollama").first()
        if row is not None:
            payload = {"source": row.source_url, "fetched_at": row.fetched_at, "origin": "live", "models": row.data}
        else:
            snap = load_snapshot()
            payload = {
                "source": snap.get("source", ""),
                "fetched_at": snap.get("fetched_at"),
                "origin": "snapshot",
                "models": snap.get("models", []),
            }
        response = Response(payload)
        response["Cache-Control"] = "private, max-age=3600"
        return response
