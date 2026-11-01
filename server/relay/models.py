"""
relay — blind WebSocket relay (Django Channels consumers). ZERO business logic.

ConnectionLog is metadata only (SPEC §1.3, §11.1): no IP, no payload, no sizes of
individual messages — just totals per connection. Retention: RELAY_LOG_RETENTION_DAYS.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models


class ConnectionLog(models.Model):
    CLIENT, DEVICE = "client", "device"
    KINDS = [(CLIENT, "client"), (DEVICE, "device")]

    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.CASCADE, related_name="relay_logs")
    device = models.ForeignKey("devices.Device", null=True, blank=True, on_delete=models.SET_NULL, related_name="relay_logs")
    kind = models.CharField(max_length=6, choices=KINDS)
    connected_at = models.DateTimeField()
    disconnected_at = models.DateTimeField(null=True, blank=True)
    bytes_in = models.PositiveBigIntegerField(default=0)
    bytes_out = models.PositiveBigIntegerField(default=0)
    frames_in = models.PositiveBigIntegerField(default=0)
    frames_out = models.PositiveBigIntegerField(default=0)
    close_code = models.PositiveIntegerField(null=True, blank=True)

    class Meta:
        db_table = "relay_connection_log"
        indexes = [models.Index(fields=["connected_at"])]

    def __str__(self) -> str:
        return f"{self.kind} {self.user_id} {self.connected_at:%Y-%m-%d %H:%M}"
