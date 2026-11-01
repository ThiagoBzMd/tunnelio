"""Optional bot check: the widget's token is verified at BOT_CHECK_VERIFY_URL, the provider's
server-side check (the usual form fields `secret`, `response` and `remoteip`; a JSON answer with
`success`).

Off when BOT_CHECK_SECRET_KEY is empty (settings require the five BOT_CHECK_* together).
"""

from __future__ import annotations

import json
import logging
import urllib.parse
import urllib.request

from django.conf import settings

log = logging.getLogger(__name__)


def enabled() -> bool:
    return bool(getattr(settings, "BOT_CHECK_SECRET_KEY", ""))


def verify(token: str | None, remote_ip: str | None = None) -> bool:
    """Return True when the bot check is disabled or the token validates."""
    if not enabled():
        return True
    if not token:
        return False
    data = {"secret": settings.BOT_CHECK_SECRET_KEY, "response": token}
    if remote_ip:
        data["remoteip"] = remote_ip
    try:
        req = urllib.request.Request(settings.BOT_CHECK_VERIFY_URL, data=urllib.parse.urlencode(data).encode(), method="POST")
        with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310 (https URL checked in settings)
            return bool(json.load(resp).get("success"))
    except Exception:  # network errors → fail closed
        log.warning("bot check verification failed (network)")
        return False
