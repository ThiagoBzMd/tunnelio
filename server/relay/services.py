"""Outbound interface of the relay for the other apps (SPEC §3.9)."""

from __future__ import annotations

from channels.db import database_sync_to_async
from channels.layers import get_channel_layer

from . import presence


def is_online(device_id: str) -> bool:
    return presence.is_online(device_id)


async def disconnect_device(device_id: str, reason: str = "revoked") -> bool:
    """Close the live connection of a device (DELETE /api/devices/{id}, account deletion)."""
    channel = presence.get_channel(device_id)
    presence.set_offline(device_id)
    if channel is None:
        return False
    await get_channel_layer().send(channel, {"type": "relay.revoked", "reason": reason})
    return True


async def disconnect_user_devices(user_id, reason: str = "account_deleted") -> int:
    from devices.models import Device

    ids = await database_sync_to_async(
        lambda: [str(i) for i in Device.objects.filter(user_id=user_id).values_list("id", flat=True)]
    )()
    count = 0
    for device_id in ids:
        if await disconnect_device(device_id, reason):
            count += 1
    return count
