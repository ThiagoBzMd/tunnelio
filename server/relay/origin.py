"""Origin check of the browser relay socket (/ws/client, SPEC §3.2).

The handshake is accepted when its Origin is this server's own address — the Host (or
X-Forwarded-Host, set by a proxy in front) of the same request, provided ALLOWED_HOSTS accepts it,
the way Django's CSRF check treats a same-origin form — or one of CSRF_TRUSTED_ORIGINS (the Vite
dev server on another port, the E2E). A page on another site cannot open the relay with the
user's cookie: browsers set Origin and Host themselves. A self-hosted server therefore needs only
ALLOWED_HOSTS for its own name.
"""

from __future__ import annotations

from urllib.parse import urlparse

from channels.security.websocket import OriginValidator
from django.conf import settings
from django.http.request import split_domain_port, validate_host

_DEFAULT_PORT = {"http": "80", "https": "443"}


def same_origin(headers: list[tuple[bytes, bytes]]) -> bool:
    """Origin == the request's own host:port (scheme-agnostic: TLS may end at a proxy)."""
    by_name = {name.lower(): value for name, value in headers}
    raw = by_name.get(b"origin")
    if not raw:
        return False
    try:
        origin = urlparse(raw.decode("latin1"))
        origin_port = str(origin.port) if origin.port else _DEFAULT_PORT.get(origin.scheme, "")
    except (UnicodeDecodeError, ValueError):
        return False
    if origin.scheme not in _DEFAULT_PORT or not origin.hostname:
        return False
    for name in (b"host", b"x-forwarded-host"):
        value = by_name.get(name)
        if not value:
            continue
        host = value.decode("latin1").split(",")[0].strip().lower()
        domain, port = split_domain_port(host)
        if not domain or not validate_host(domain, settings.ALLOWED_HOSTS):
            continue
        if domain == origin.hostname.lower() and (port or _DEFAULT_PORT[origin.scheme]) == origin_port:
            return True
    return False


class SameOriginValidator(OriginValidator):
    def __init__(self, application):
        super().__init__(application, settings.CSRF_TRUSTED_ORIGINS)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "websocket" and same_origin(scope.get("headers", [])):
            return await self.application(scope, receive, send)
        return await super().__call__(scope, receive, send)
