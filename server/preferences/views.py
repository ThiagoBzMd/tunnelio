"""
REST API for the synced preferences blob (SPEC §10.5). Same rules as the pairings blob (SPEC
§10.2): base64url without padding, the server stores bytes it cannot read.

    GET/PUT/DELETE /api/auth/preferences
"""

from __future__ import annotations

from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from pairings.views import b64url_decode, b64url_encode

from .models import PreferencesBlob

PREFERENCES_MAX_BYTES = 32 * 1024


def _err(code: str, message: str = "", http_status: int = 400) -> Response:
    return Response({"code": code, "message": message}, status=http_status)


class PreferencesBlobView(APIView):
    throttle_scope = "preferences_write"

    def get(self, request):
        blob = PreferencesBlob.objects.filter(user=request.user).first()
        if blob is None:
            return _err("E_NOT_FOUND", "No synced preferences.", status.HTTP_404_NOT_FOUND)
        return Response(
            {"timestamp": blob.timestamp, "ciphertext": b64url_encode(blob.ciphertext), "updated_at": blob.updated_at}
        )

    def put(self, request):
        try:
            timestamp = parse_datetime(str(request.data.get("timestamp", "")))
            if timestamp is None or timestamp.tzinfo is None:
                raise ValueError("timestamp must be ISO 8601 with timezone")
            ciphertext = b64url_decode(request.data.get("ciphertext", ""))
            if len(ciphertext) < 12 + 16:
                raise ValueError("ciphertext too short")
        except (ValueError, TypeError) as exc:
            return _err("E_INVALID", str(exc))
        if len(ciphertext) > PREFERENCES_MAX_BYTES:
            return _err("E_TOO_LARGE", "preferences blob exceeds 32 KiB", status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
        _, created = PreferencesBlob.objects.update_or_create(
            user=request.user, defaults={"timestamp": timestamp, "ciphertext": ciphertext, "size": len(ciphertext)}
        )
        return Response({"timestamp": timestamp}, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)

    def delete(self, request):
        PreferencesBlob.objects.filter(user=request.user).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
