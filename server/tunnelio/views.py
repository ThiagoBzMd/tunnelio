"""Liveness endpoint and the SPA entry (index.html fallback for client-side routes)."""

from __future__ import annotations

from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET

_index_cache: str | None = None


@require_GET
def healthz(request):
    return JsonResponse({"status": "ok"})


@never_cache
@require_GET
def version(request):
    """The public commit this server was built from (anyone can rebuild it and compare)."""
    return JsonResponse({"revision": settings.TUNNELIO_REVISION})


@never_cache
@require_GET
def spa_index(request, path: str = ""):
    global _index_cache
    if _index_cache is None or settings.DEBUG:
        index = settings.WEB_DIST_DIR / "index.html"
        if not index.exists():
            return HttpResponse("Tunnelio web app is not built (web/dist missing).", status=503, content_type="text/plain")
        _index_cache = index.read_text(encoding="utf-8")
    return HttpResponse(_index_cache, content_type="text/html; charset=utf-8")
