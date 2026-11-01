"""
Services used by the relay (SPEC §3.9): device authentication and pairing binding. Sync
functions; the relay wraps them with database_sync_to_async.
"""

from __future__ import annotations

from django.conf import settings
from django.utils import timezone

from .models import Device, PairingSession, hash_token, new_device_token


def authenticate_device(token: str | None) -> Device | None:
    if not token:
        return None
    return Device.objects.select_related("user").filter(token_hash=hash_token(token), user__is_active=True).first()


def touch_device(device_id, *, platform: str = "", tray_version: str = "") -> None:
    fields = {"last_seen_at": timezone.now()}
    if platform:
        fields["platform"] = platform[:16]
    if tray_version:
        fields["tray_version"] = tray_version[:32]
    Device.objects.filter(id=device_id).update(**fields)


class DeviceLimitReached(Exception):
    pass


def pairing_bind(
    session: PairingSession, device_name: str, *, platform: str = "", tray_version: str = ""
) -> tuple[Device, str | None]:
    """
    Called when the device reports pair_done{ok:true}. First pairing of a device creates the
    Device row and returns its plaintext token (sent once to the tray). Later pairings (other
    browsers) return (device, None).
    """
    if session.device is not None:
        session.state = PairingSession.DONE
        session.save(update_fields=["state"])
        return session.device, None
    user = session.user
    if user is None:
        raise ValueError("pairing session has no user")
    if Device.objects.filter(user=user).count() >= settings.DEVICES_MAX_PER_USER:
        raise DeviceLimitReached()
    token, token_hash = new_device_token()
    device = Device.objects.create(
        user=user,
        name=(device_name or "Device")[:64],
        platform=platform[:16],
        tray_version=tray_version[:32],
        token_hash=token_hash,
        last_seen_at=timezone.now(),
    )
    session.device = device
    session.state = PairingSession.DONE
    session.save(update_fields=["device", "state"])
    return device, token
