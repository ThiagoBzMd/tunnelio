"""
devices — registration, user-approved pairing, online/offline status (SPEC §4, §11.1).

The 8-symbol pairing secret NEVER reaches the server. Presence is kept in the cache
(relay.presence), not here.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def new_device_token() -> tuple[str, str]:
    """Return (token, sha256 hex). The plaintext token is only ever sent to the tray once."""
    token = secrets.token_urlsafe(32)
    return token, hash_token(token)


class Device(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="devices")
    name = models.CharField(max_length=64)
    platform = models.CharField(max_length=16, blank=True, default="")
    tray_version = models.CharField(max_length=32, blank=True, default="")
    token_hash = models.CharField(max_length=64, unique=True, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "devices_device"
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.name} ({str(self.id)[:8]})"


class PairingSession(models.Model):
    """One pairing attempt. Routing key is the 4-symbol claim; the secret never arrives."""

    WAITING, JOINED, DONE, FAILED, EXPIRED = "waiting", "joined", "done", "failed", "expired"
    STATES = [(s, s) for s in (WAITING, JOINED, DONE, FAILED, EXPIRED)]
    ACTIVE = (WAITING, JOINED)

    claim = models.CharField(max_length=4, db_index=True)
    device = models.ForeignKey(Device, null=True, blank=True, on_delete=models.CASCADE, related_name="pairing_sessions")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="pairing_sessions"
    )
    state = models.CharField(max_length=8, choices=STATES, default=WAITING)
    device_channel = models.CharField(max_length=255)
    client_channel = models.CharField(max_length=255, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()

    class Meta:
        db_table = "devices_pairing_session"

    def __str__(self) -> str:
        return f"{self.claim} [{self.state}]"

    @property
    def is_expired(self) -> bool:
        return timezone.now() >= self.expires_at

    @classmethod
    def new_claim(cls) -> str:
        """Random 4-symbol Crockford claim, unique among active (non-expired) sessions."""
        now = timezone.now()
        for _ in range(50):
            claim = "".join(secrets.choice(CROCKFORD) for _ in range(4))
            if not cls.objects.filter(claim=claim, state__in=cls.ACTIVE, expires_at__gt=now).exists():
                return claim
        raise RuntimeError("could not allocate a pairing claim")

    @classmethod
    def start(cls, device_channel: str, device: Device | None) -> PairingSession:
        return cls.objects.create(
            claim=cls.new_claim(),
            device=device,
            device_channel=device_channel,
            expires_at=timezone.now() + timedelta(seconds=settings.PAIR_TTL_SECONDS),
        )

    @classmethod
    def find_active(cls, claim: str) -> PairingSession | None:
        return (
            cls.objects.filter(claim=claim.upper(), state__in=cls.ACTIVE, expires_at__gt=timezone.now())
            .select_related("device", "user")
            .first()
        )
