from .base import *  # noqa: F401,F403
from .base import env

DEBUG = False
if SECRET_KEY == "insecure-dev-only-change-me":  # noqa: F405
    raise RuntimeError("SECRET_KEY must be set in production")

# Loopback is always allowed: the container healthcheck and the reverse proxy hit 127.0.0.1.
ALLOWED_HOSTS = sorted(set(ALLOWED_HOSTS) | {"localhost", "127.0.0.1"})  # noqa: F405

# Behind a proxy that ends TLS (a tunnel and nginx in production; Tailscale serve or another proxy
# when self-hosted).
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
USE_X_FORWARDED_HOST = True
SECURE_SSL_REDIRECT = False
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"
SILENCED_SYSTEM_CHECKS = ["security.W004", "security.W008"]  # HSTS/redirect belong to the proxy in front

# InMemoryChannelLayer is single-process only: refuse multiple workers without Redis (SPEC §14.5).
if int(env("UVICORN_WORKERS", "1") or "1") > 1 and not env("REDIS_URL"):
    raise RuntimeError("UVICORN_WORKERS > 1 requires REDIS_URL (channels_redis)")
