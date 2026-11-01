from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from .models import User


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    """Email-only user admin. No profile data exists beyond what is shown here."""

    ordering = ["-created_at"]
    list_display = ["email", "is_active", "is_staff", "created_at", "last_login"]
    list_filter = ["is_active", "is_staff"]
    search_fields = ["email"]
    readonly_fields = ["created_at", "last_login"]
    fieldsets = [
        (None, {"fields": ["email", "password"]}),
        ("Status", {"fields": ["is_active", "is_staff", "is_superuser", "groups"]}),
        ("Dates", {"fields": ["created_at", "last_login"]}),
    ]
    add_fieldsets = [(None, {"classes": ["wide"], "fields": ["email", "password1", "password2"]})]
    filter_horizontal = ["groups"]
