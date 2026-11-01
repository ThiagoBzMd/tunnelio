"""
preferences — the account's settings (theme, language, pinned conversations, model settings, the
name to be called by…) as ONE opaque blob, sealed in the browser with the key derived from the
sign-in password (SPEC §10.5), so every browser of the account gets them. Same shape as the
pairings blob; the server never sees a key nor the content; admin exposes size and timestamps only.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models


class PreferencesBlob(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="preferences_blob")
    timestamp = models.DateTimeField()
    ciphertext = models.BinaryField()
    size = models.PositiveIntegerField()
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "preferences_blob"

    def __str__(self) -> str:
        return f"preferences of {self.user_id} ({self.size} B)"
