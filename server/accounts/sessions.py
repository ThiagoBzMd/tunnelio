"""
Active sessions (SPEC §11.2): which browsers are signed in, from what they announce about
themselves (User-Agent → browser, system, kind of device), and how to end them — the cookie dies
(Django session deleted) and the relay socket of that browser closes right away.

A browser's row outlives its session key: Django changes the key when the password changes
(`update_session_auth_hash`), so the row is re-keyed and the relay sockets are grouped by the row,
not by the key.
"""

from __future__ import annotations

import hashlib
import re
from datetime import timedelta

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.utils import timezone

from .models import LoginSession

TOUCH_EVERY = timedelta(minutes=5)

_BROWSERS = [  # first match wins: the derived browsers announce the ones they derive from too
    (re.compile(r"\bEdgA?/|\bEdge/"), "Edge"),
    (re.compile(r"\bOPR/|\bOpera\b"), "Opera"),
    (re.compile(r"\bSamsungBrowser/"), "Samsung Internet"),
    (re.compile(r"\bFirefox/|\bFxiOS/"), "Firefox"),
    (re.compile(r"\bCriOS/|\bChrome/|\bChromium/"), "Chrome"),
    (re.compile(r"\bSafari/"), "Safari"),
]
_SYSTEMS = [
    (re.compile(r"iPhone|iPod"), "iOS"),
    (re.compile(r"iPad"), "iPadOS"),
    (re.compile(r"Android"), "Android"),
    (re.compile(r"CrOS"), "ChromeOS"),
    (re.compile(r"Windows"), "Windows"),
    (re.compile(r"Mac OS X|Macintosh"), "macOS"),
    (re.compile(r"Linux|X11"), "Linux"),
]


def parse_user_agent(ua: str) -> tuple[str, str, str]:
    """→ (browser, system, device kind); "" when unknown."""
    ua = ua or ""
    browser = next((name for rx, name in _BROWSERS if rx.search(ua)), "")
    system = next((name for rx, name in _SYSTEMS if rx.search(ua)), "")
    if system == "iOS" or (system == "Android" and "Mobile" in ua):
        device = LoginSession.PHONE
    elif system in ("iPadOS", "Android"):
        device = LoginSession.TABLET
    elif system:
        device = LoginSession.COMPUTER
    else:
        device = LoginSession.OTHER
    return browser, system, device


def _row_group(row_id: int) -> str:
    return f"login.row.{row_id}"


def _key_group(session_key: str) -> str:
    return "login.key." + hashlib.sha256(session_key.encode()).hexdigest()[:32]  # never the key itself


def socket_group(session_key: str) -> str:
    """Channels group of the relay sockets opened with this session: its row's, or (no row) its key's."""
    row_id = LoginSession.objects.filter(session_key=session_key).values_list("pk", flat=True).first()
    return _row_group(row_id) if row_id else _key_group(session_key)


def record(request, user) -> None:
    """Create or refresh the row of the current session (sign-in, or a session older than the table)."""
    key = getattr(request.session, "session_key", None)
    if not key:
        return
    browser, system, device = parse_user_agent(request.META.get("HTTP_USER_AGENT", ""))
    LoginSession.objects.update_or_create(
        session_key=key,
        defaults={"user": user, "browser": browser, "os": system, "device": device, "last_seen_at": timezone.now()},
    )
    cache.set(f"ls:{key}", 1, int(TOUCH_EVERY.total_seconds()))


def touch(request) -> None:
    """Signed-in request: refresh `last_seen_at` at most every TOUCH_EVERY (cache-throttled)."""
    key = getattr(request.session, "session_key", None)
    if not key or cache.get(f"ls:{key}"):
        return
    record(request, request.user)


def rekey(old_key: str | None, new_key: str | None) -> None:
    """The session got a new key (password change): same browser, same row, same sockets."""
    if old_key and new_key and old_key != new_key:
        LoginSession.objects.filter(session_key=old_key).update(session_key=new_key)
        cache.delete(f"ls:{old_key}")


def forget(session_key: str | None) -> None:
    if session_key:
        LoginSession.objects.filter(session_key=session_key).delete()
        cache.delete(f"ls:{session_key}")


def live_sessions(user):
    """The user's rows whose Django session still exists and has not expired, newest use first."""
    alive = Session.objects.filter(expire_date__gt=timezone.now()).values("session_key")
    return LoginSession.objects.filter(user=user, session_key__in=alive).order_by("-last_seen_at")


def user_session_keys(user) -> set[str]:
    """Every live Django session of the user, with or without a row (sessions older than the table)."""
    keys = set(LoginSession.objects.filter(user=user).values_list("session_key", flat=True))
    uid = str(user.pk)
    for s in Session.objects.filter(expire_date__gt=timezone.now()).iterator():
        if s.get_decoded().get("_auth_user_id") == uid:
            keys.add(s.session_key)
    return keys


def revoke(session_keys) -> int:
    """End these sessions: cookie invalid, row gone, relay sockets of those browsers closed."""
    keys = [k for k in set(session_keys) if k]
    if not keys:
        return 0
    rows = LoginSession.objects.filter(session_key__in=keys)
    groups = [_row_group(pk) for pk in rows.values_list("pk", flat=True)] + [_key_group(k) for k in keys]
    Session.objects.filter(session_key__in=keys).delete()
    rows.delete()
    for key in keys:
        cache.delete(f"ls:{key}")
    layer = get_channel_layer()
    if layer is not None:
        for group in groups:
            async_to_sync(layer.group_send)(group, {"type": "session.revoked"})
    return len(keys)
