"""
Device presence in the Django cache (SPEC §3.7). Works with LocMemCache (single process) and
Redis (multi-worker). Value = channel name of the live device connection.
"""

from __future__ import annotations

from django.core.cache import cache

TTL = 120  # seconds; refreshed on every device ping (30 s)


def _key(device_id: str) -> str:
    return f"presence:device:{device_id}"


def set_online(device_id: str, channel_name: str) -> None:
    cache.set(_key(device_id), channel_name, TTL)


def refresh(device_id: str, channel_name: str) -> None:
    cache.set(_key(device_id), channel_name, TTL)


def set_offline(device_id: str, channel_name: str | None = None) -> bool:
    """Clear presence. If channel_name is given, only clear when it still owns the key."""
    current = cache.get(_key(device_id))
    if channel_name is not None and current != channel_name:
        return False
    cache.delete(_key(device_id))
    return True


def get_channel(device_id: str) -> str | None:
    return cache.get(_key(device_id))


def is_online(device_id: str) -> bool:
    return cache.get(_key(device_id)) is not None


def online_set(device_ids: list[str]) -> set[str]:
    found = cache.get_many([_key(d) for d in device_ids])
    return {k.split(":", 2)[2] for k in found}
