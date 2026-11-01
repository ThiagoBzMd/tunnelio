from django.urls import path

from pairings.views import PairingsBlobView

from . import views

urlpatterns = [
    path("", views.DeviceListView.as_view(), name="devices-list"),
    path("<uuid:device_id>", views.DeviceDetailView.as_view(), name="devices-detail"),
    path("pairings", PairingsBlobView.as_view(), name="devices-pairings"),
]
