from django.contrib import admin

from .models import OllamaCatalog


@admin.register(OllamaCatalog)
class OllamaCatalogAdmin(admin.ModelAdmin):
    list_display = ["key", "count", "fetched_at", "source_url"]
    readonly_fields = ["key", "count", "fetched_at", "source_url"]
    fields = readonly_fields

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
