"""
REST API for devices (SPEC §11.2).

    GET    /api/devices/            [{id, name, platform, tray_version, created_at, last_seen_at, online}]
    PATCH  /api/devices/{id}        {name}
    DELETE /api/devices/{id}        revokes the token and closes the tray connection (relay `revoked` + 4001)
"""

from __future__ import annotations

from asgiref.sync import async_to_sync
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from relay import presence
from relay.services import disconnect_device

from .models import Device


def serialize(device: Device, online: bool) -> dict:
    return {
        "id": str(device.id),
        "name": device.name,
        "platform": device.platform,
        "tray_version": device.tray_version,
        "created_at": device.created_at,
        "last_seen_at": device.last_seen_at,
        "online": online,
    }


class DeviceListView(APIView):
    def get(self, request):
        devices = list(request.user.devices.all())
        online = presence.online_set([str(d.id) for d in devices])
        return Response([serialize(d, str(d.id) in online) for d in devices])


class DeviceDetailView(APIView):
    def _get(self, request, device_id):
        return request.user.devices.filter(id=device_id).first()

    def patch(self, request, device_id):
        device = self._get(request, device_id)
        if device is None:
            return Response({"code": "E_NOT_FOUND"}, status=status.HTTP_404_NOT_FOUND)
        name = str(request.data.get("name", "")).strip()
        if not name or len(name) > 64:
            return Response({"code": "E_INVALID", "message": "name must be 1–64 characters"}, status=400)
        device.name = name
        device.save(update_fields=["name"])
        return Response(serialize(device, presence.is_online(str(device.id))))

    def delete(self, request, device_id):
        device = self._get(request, device_id)
        if device is None:
            return Response({"code": "E_NOT_FOUND"}, status=status.HTTP_404_NOT_FOUND)
        async_to_sync(disconnect_device)(str(device.id), reason="revoked")
        device.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
