"""
URL layout (SPEC §11.2–11.4):

    /<ADMIN_URL_PATH>/        Django admin (production: an obscure path, never on the public hostname)
    /api/auth/...             accounts
    /api/devices/...          devices
    /api/catalog/...          catalog (public model list, fetched daily)
    /healthz                  liveness (no auth)
    /api/version              the public commit this image was built from (no auth)
    /*                        SPA (web/dist) — whitenoise serves /assets/*; this fallback serves index.html
"""

from django.conf import settings
from django.contrib import admin
from django.urls import include, path, re_path

from . import views

urlpatterns = [
    path(f"{settings.ADMIN_URL_PATH}/", admin.site.urls),
    path("api/auth/", include("accounts.urls")),
    path("api/devices/", include("devices.urls")),
    path("api/catalog/", include("catalog.urls")),
    path("healthz", views.healthz, name="healthz"),
    path("api/version", views.version, name="version"),
    re_path(r"^(?!api/|ws/|static/|assets/)(?P<path>.*)$", views.spa_index, name="spa"),
]
