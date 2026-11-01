from django.contrib import admin

from .models import PreferencesBlob


@admin.register(PreferencesBlob)
class PreferencesBlobAdmin(admin.ModelAdmin):
    """Size and timestamps only — never the ciphertext."""

    list_display = ["user", "size", "timestamp", "updated_at"]
    readonly_fields = ["user", "size", "timestamp", "updated_at"]
    fields = readonly_fields
    exclude = ["ciphertext"]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
