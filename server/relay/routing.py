from channels.auth import AuthMiddlewareStack
from django.urls import path

from .consumers import ClientConsumer, DeviceConsumer
from .origin import SameOriginValidator

websocket_urlpatterns = [
    # Browser: session cookie + Origin = this server's own address or one of CSRF_TRUSTED_ORIGINS (SPEC §3.2)
    path("ws/client", SameOriginValidator(AuthMiddlewareStack(ClientConsumer.as_asgi()))),
    # Tray: Authorization: Bearer <device_token> (or none while unpaired)
    path("ws/device", DeviceConsumer.as_asgi()),
]
