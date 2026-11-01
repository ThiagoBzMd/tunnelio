"""
pairings — the one opaque blob the server keeps per account: the browser-side pairing secrets,
encrypted in the browser with a key derived from the sign-in password (SPEC §10.2). The server
never sees a key; admin exposes size and timestamps only.

History: this lived in the former `vault` app (cloud conversation storage, removed in rev. 1.3);
migration 0001 adopts its table.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models


class PairingsBlob(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="pairings_blob")
    timestamp = models.DateTimeField()
    ciphertext = models.BinaryField()
    size = models.PositiveIntegerField()
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "pairings_blob"

    def __str__(self) -> str:
        return f"pairings of {self.user_id} ({self.size} B)"
