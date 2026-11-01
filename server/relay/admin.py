from django.contrib import admin

from .models import ConnectionLog


@admin.register(ConnectionLog)
class ConnectionLogAdmin(admin.ModelAdmin):
    list_display = [
        "kind",
        "user",
        "device",
        "connected_at",
        "disconnected_at",
        "frames_in",
        "frames_out",
        "bytes_in",
        "bytes_out",
        "close_code",
    ]
    list_filter = ["kind", "close_code"]
    search_fields = ["user__email"]
    readonly_fields = [f.name for f in ConnectionLog._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
