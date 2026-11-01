from .base import *  # noqa: F401,F403
from .base import env_list

DEBUG = True
ALLOWED_HOSTS = ["*"]
# Local origins always allowed in dev; extra ones (other ports) via the CSRF_TRUSTED_ORIGINS env.
CSRF_TRUSTED_ORIGINS = sorted(
    set(env_list("CSRF_TRUSTED_ORIGINS", "")) | {"http://localhost:8080", "http://127.0.0.1:8080", "http://localhost:5173"}
)
SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False
