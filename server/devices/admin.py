from django.contrib import admin

from .models import Device, PairingSession


@admin.register(Device)
class DeviceAdmin(admin.ModelAdmin):
    """token_hash is deliberately not shown anywhere."""

    list_display = ["name", "user", "platform", "tray_version", "created_at", "last_seen_at"]
    list_filter = ["platform"]
    search_fields = ["name", "user__email", "id"]
    readonly_fields = ["id", "created_at", "last_seen_at"]
    fields = ["id", "user", "name", "platform", "tray_version", "created_at", "last_seen_at"]
    exclude = ["token_hash"]


@admin.register(PairingSession)
class PairingSessionAdmin(admin.ModelAdmin):
    list_display = ["claim", "state", "user", "device", "created_at", "expires_at"]
    list_filter = ["state"]
    readonly_fields = ["claim", "state", "user", "device", "device_channel", "client_channel", "created_at", "expires_at"]
