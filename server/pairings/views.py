"""
REST API for the synced pairings blob (SPEC §10.2). Binary fields travel as base64url without padding.

    GET/PUT/DELETE /api/devices/pairings
"""

from __future__ import annotations

import base64
import binascii

from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import PairingsBlob

PAIRINGS_MAX_BYTES = 64 * 1024


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(bytes(data)).rstrip(b"=").decode("ascii")


def b64url_decode(text: str, expected_len: int | None = None) -> bytes:
    if not isinstance(text, str):
        raise ValueError("expected string")
    pad = "=" * (-len(text) % 4)
    try:
        data = base64.urlsafe_b64decode(text + pad)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("invalid base64url") from exc
    if expected_len is not None and len(data) != expected_len:
        raise ValueError(f"expected {expected_len} bytes")
    return data


def _err(code: str, message: str = "", http_status: int = 400) -> Response:
    return Response({"code": code, "message": message}, status=http_status)


class PairingsBlobView(APIView):
    """GET/PUT/DELETE /api/devices/pairings — the encrypted pairing-secret bundle (SPEC §10.2)."""

    throttle_scope = "pairings_write"

    def get(self, request):
        blob = PairingsBlob.objects.filter(user=request.user).first()
        if blob is None:
            return _err("E_NOT_FOUND", "No synced pairings.", status.HTTP_404_NOT_FOUND)
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
        if len(ciphertext) > PAIRINGS_MAX_BYTES:
            return _err("E_TOO_LARGE", "pairings blob exceeds 64 KiB", status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
        blob, created = PairingsBlob.objects.update_or_create(
            user=request.user, defaults={"timestamp": timestamp, "ciphertext": ciphertext, "size": len(ciphertext)}
        )
        return Response({"timestamp": blob.timestamp}, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)

    def delete(self, request):
        PairingsBlob.objects.filter(user=request.user).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
