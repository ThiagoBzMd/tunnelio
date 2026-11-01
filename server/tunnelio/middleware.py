"""The visitor's address behind a proxy or tunnel.

In production a request reaches Django through the tunnel and nginx, so REMOTE_ADDR is the proxy
and X-Forwarded-For starts with whatever the visitor sent (uvicorn trusts that header only from
FORWARDED_ALLOW_IPS, by default only loopback: entrypoint.sh). When the proxy in front always
overwrites a header with the real visitor address, CLIENT_IP_HEADER names it and its value becomes
REMOTE_ADDR. DRF throttles (NUM_PROXIES = 0) and the bot check then see one stable, unforgeable
address per visitor.
"""

from __future__ import annotations

import ipaddress

from django.conf import settings


class ClientIPMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        header = getattr(settings, "CLIENT_IP_HEADER", "")
        if header:
            ip = request.META.get("HTTP_" + header.upper().replace("-", "_"), "").strip()
            try:
                request.META["REMOTE_ADDR"] = str(ipaddress.ip_address(ip))
            except ValueError:
                pass  # absent or malformed: keep the socket address
        return self.get_response(request)
