"""Keeps the active-sessions list (accounts.sessions) current for signed-in requests."""

from __future__ import annotations

from . import sessions


class LoginSessionMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        # Before the view: a session older than the table shows up in its own first listing.
        user = getattr(request, "user", None)
        if user is not None and user.is_authenticated:
            sessions.touch(request)
        return self.get_response(request)
