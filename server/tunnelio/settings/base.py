"""
Tunnelio server — base settings.

Everything is configured through environment variables (SPEC.md §11.5). This file is the
single place that reads them; dev.py / prod.py / test.py only override behaviour.

The server implements NO channel cryptography. It authenticates, registers devices, relays
opaque frames and stores one opaque pairings blob per account. See docs/SPEC.md §1.3 for the exhaustive list of
what it knows.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent.parent  # server/


def env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def env_bool(name: str, default: bool) -> bool:
    value = env(name)
    return default if value is None else value.strip().lower() in ("1", "true", "yes", "on")


def env_int(name: str, default: int) -> int:
    value = env(name)
    return default if value is None else int(value)


def env_list(name: str, default: str) -> list[str]:
    return [item.strip() for item in (env(name) or default).split(",") if item.strip()]


# ── Core ─────────────────────────────────────────────────────────────────────
SECRET_KEY = env("SECRET_KEY", "insecure-dev-only-change-me")
DEBUG = False
ALLOWED_HOSTS = env_list("ALLOWED_HOSTS", "localhost,127.0.0.1")
CSRF_TRUSTED_ORIGINS = env_list("CSRF_TRUSTED_ORIGINS", "http://localhost:8080,http://localhost:5173")
DATA_DIR = Path(env("DATA_DIR", str(BASE_DIR / "data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)

INSTALLED_APPS = [
    "channels",  # Django Channels (ASGI); served by uvicorn, not daphne (SPEC §14.5)
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    # Local apps — one responsibility each (SPEC §11.1)
    "accounts",
    "devices",
    "pairings",
    "preferences",
    "relay",
    "catalog",
]

MIDDLEWARE = [
    "tunnelio.middleware.ClientIPMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "accounts.middleware.LoginSessionMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "tunnelio.urls"
ASGI_APPLICATION = "tunnelio.asgi.application"
WSGI_APPLICATION = None  # ASGI only

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

# ── Database: SQLite in DATA_DIR by default; DATABASE_URL switches to Postgres ──
_db_url = env("DATABASE_URL")
if _db_url:
    import dj_database_url  # type: ignore[import-not-found]

    DATABASES = {"default": dj_database_url.parse(_db_url, conn_max_age=60, conn_health_checks=True)}
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": DATA_DIR / "db.sqlite3",
            # IMMEDIATE: a transaction takes the write lock when it begins, so a concurrent writer
            # waits (up to `timeout`) instead of failing with "database is locked" when a read
            # inside the transaction turns into a write (get_or_create, update_or_create).
            "OPTIONS": {
                "timeout": 20,
                "transaction_mode": "IMMEDIATE",
                "init_command": "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;",
            },
        }
    }
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ── Channel layer: in-memory (single process) by default; REDIS_URL → channels_redis ──
REDIS_URL = env("REDIS_URL")
if REDIS_URL:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {"hosts": [REDIS_URL], "capacity": 1500, "expiry": 10},
        }
    }
else:
    CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}

# ── Cache: presence + rate limits + DRF throttles. LocMem (single process) or Redis ──
if REDIS_URL:
    CACHES = {"default": {"BACKEND": "django.core.cache.backends.redis.RedisCache", "LOCATION": REDIS_URL}}
else:
    CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "tunnelio"}}

# ── Auth ─────────────────────────────────────────────────────────────────────
AUTH_USER_MODEL = "accounts.User"
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
]
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 10}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
SESSION_COOKIE_AGE = 14 * 24 * 3600
SESSION_SAVE_EVERY_REQUEST = True
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"
CSRF_HEADER_NAME = "HTTP_X_CSRFTOKEN"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.SessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.ScopedRateThrottle"],
    # Identify clients by REMOTE_ADDR only (set from CLIENT_IP_HEADER when there is one, see
    # tunnelio/middleware.py); X-Forwarded-For can be forged by the visitor.
    "NUM_PROXIES": 0,
    "DEFAULT_THROTTLE_RATES": {
        "register": "3/minute",
        "login": "5/minute",
        "verify": "10/minute",
        "reset": "5/minute",
        "resend": "3/minute",
        "totp": "10/minute",
        "change_password": "5/minute",
        "delete_account": "3/hour",
        "catalog": "60/minute",
        "preferences_write": "60/minute",
        "sessions": "20/minute",
        "pairings_write": "60/minute",
    },
}

# ── Product settings (SPEC §3.8, §10.3, §11.5) ───────────────────────────────
ADMIN_URL_PATH = (env("ADMIN_URL_PATH", "admin") or "admin").strip("/")
# The header in which the proxy or tunnel in front puts the visitor's address, always overwriting
# what the visitor sent (e.g. `X-Real-IP` from your own reverse proxy). Empty: the socket address.
# Anywhere else a client could forge the header and dodge the attempt limits, so it stays empty
# unless the operator names one.
CLIENT_IP_HEADER = (env("CLIENT_IP_HEADER") or "").strip()
if CLIENT_IP_HEADER and not re.fullmatch(r"[A-Za-z0-9-]+", CLIENT_IP_HEADER):
    raise ImproperlyConfigured("CLIENT_IP_HEADER must be a header name, e.g. X-Real-IP")
REGISTRATION_ENABLED = env_bool("REGISTRATION_ENABLED", True)
DEVICES_MAX_PER_USER = env_int("DEVICES_MAX_PER_USER", 20)
RELAY_MAX_FRAME_BYTES = env_int("RELAY_MAX_FRAME_BYTES", 8 * 1024 * 1024)  # 8 MiB: chat messages with images (SPEC §7.6)
RELAY_CLIENT_FPS = env_int("RELAY_CLIENT_FPS", 20)
RELAY_DEVICE_FPS = env_int("RELAY_DEVICE_FPS", 60)
RELAY_BYTES_PER_MIN = env_int("RELAY_BYTES_PER_MIN", 64 * 1024 * 1024)
RELAY_MAX_CLIENTS_PER_USER = env_int("RELAY_MAX_CLIENTS_PER_USER", 10)
RELAY_MAX_SESSIONS_PER_CLIENT = env_int("RELAY_MAX_SESSIONS_PER_CLIENT", 5)
RELAY_IDLE_TIMEOUT_SECONDS = env_int("RELAY_IDLE_TIMEOUT_SECONDS", 90)
RELAY_LOG_RETENTION_DAYS = env_int("RELAY_LOG_RETENTION_DAYS", 7)
PAIR_TTL_SECONDS = env_int("PAIR_TTL_SECONDS", 300)
PAIR_JOIN_RATE = env("PAIR_JOIN_RATE", "5/minute")
# Optional bot check on login, sign-up, reset and resend: on only with all five set, as the provider
# documents them (the widget's script, the object that script defines, the server-side check).
BOT_CHECK_SECRET_KEY = env("BOT_CHECK_SECRET_KEY")
BOT_CHECK_SITE_KEY = env("BOT_CHECK_SITE_KEY")
BOT_CHECK_SCRIPT_URL = env("BOT_CHECK_SCRIPT_URL")
BOT_CHECK_GLOBAL = env("BOT_CHECK_GLOBAL")
BOT_CHECK_VERIFY_URL = env("BOT_CHECK_VERIFY_URL")
_bot_check = (BOT_CHECK_SECRET_KEY, BOT_CHECK_SITE_KEY, BOT_CHECK_SCRIPT_URL, BOT_CHECK_GLOBAL, BOT_CHECK_VERIFY_URL)
if any(_bot_check) and not all(_bot_check):
    raise ImproperlyConfigured("BOT_CHECK_SECRET_KEY, _SITE_KEY, _SCRIPT_URL, _GLOBAL and _VERIFY_URL go together (or none)")
if any(url and not url.startswith("https://") for url in (BOT_CHECK_SCRIPT_URL, BOT_CHECK_VERIFY_URL)):
    raise ImproperlyConfigured("BOT_CHECK_SCRIPT_URL and BOT_CHECK_VERIFY_URL must be https:// addresses")
if BOT_CHECK_GLOBAL and not re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", BOT_CHECK_GLOBAL):
    raise ImproperlyConfigured("BOT_CHECK_GLOBAL must be the name of the object the widget's script defines")

# ── Email: optional. EMAIL_URL empty → no verification / no password reset ──
EMAIL_URL = env("EMAIL_URL")
EMAIL_ENABLED = bool(EMAIL_URL)
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", "Tunnelio <noreply@localhost>")
# 6-digit codes (e-mail verification at signup, password reset)
EMAIL_CODE_TTL_MINUTES = env_int("EMAIL_CODE_TTL_MINUTES", 15)
EMAIL_CODES_PER_HOUR = env_int("EMAIL_CODES_PER_HOUR", 3)
EMAIL_CODE_MAX_ATTEMPTS = env_int("EMAIL_CODE_MAX_ATTEMPTS", 5)
UNVERIFIED_ACCOUNT_TTL_DAYS = env_int("UNVERIFIED_ACCOUNT_TTL_DAYS", 7)
# Optional second factor (authenticator app)
TOTP_ISSUER = env("TOTP_ISSUER", "Tunnelio")
TOTP_MAX_FAILED = env_int("TOTP_MAX_FAILED", 5)
TOTP_LOCK_MINUTES = env_int("TOTP_LOCK_MINUTES", 15)
if EMAIL_ENABLED:
    import dj_email_url  # type: ignore[import-not-found]

    globals().update({k: v for k, v in dj_email_url.parse(EMAIL_URL).items() if k.startswith("EMAIL_")})
    # file:///abs/dir (dev/E2E: one file per mail). dj_email_url drops the leading slash.
    if EMAIL_URL.startswith("file:///") and not str(globals().get("EMAIL_FILE_PATH", "")).startswith("/"):
        EMAIL_FILE_PATH = "/" + str(globals().get("EMAIL_FILE_PATH", ""))
else:
    EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"

# ── Static files: Django admin + the built SPA (web/dist) served by whitenoise ──
STATIC_URL = "/static/"
STATIC_ROOT = env("STATIC_ROOT", str(BASE_DIR / "staticfiles"))
WEB_DIST_DIR = Path(env("WEB_DIST_DIR", str(BASE_DIR.parent / "web" / "dist")))
WHITENOISE_ROOT = WEB_DIST_DIR if WEB_DIST_DIR.exists() else None  # serves /index.html, /assets/*, /favicon.ico
WHITENOISE_INDEX_FILE = True
STORAGES = {
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}

# ── I18N / misc ──────────────────────────────────────────────────────────────
LANGUAGE_CODE = "en"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True
X_FRAME_OPTIONS = "DENY"
SECURE_CONTENT_TYPE_NOSNIFF = True

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"plain": {"format": "[{asctime}] {levelname} {name}: {message}", "style": "{"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "plain"}},
    "root": {"handlers": ["console"], "level": env("LOG_LEVEL", "INFO")},
    "loggers": {
        "relay": {"level": env("LOG_LEVEL", "INFO")},  # metadata only — never payloads
        "django.request": {"level": "WARNING"},
    },
}

# ── Model catalog: the public Ollama library page, fetched daily by `refresh_ollama_catalog` ──
OLLAMA_LIBRARY_URL = env("OLLAMA_LIBRARY_URL", "https://ollama.com/library?sort=popular")

# The newest computer-app release, announced to trays in the relay's welcome so that their menu
# offers the update (SPEC §3.4). Both or nothing; the download page must be https.
TRAY_LATEST_VERSION = (env("TRAY_LATEST_VERSION") or "").strip()
TRAY_DOWNLOAD_URL = (env("TRAY_DOWNLOAD_URL") or "").strip()

# The commit of the public repository this image was built from (set at build time; README →
# "Verifying what tunnelio.app runs"). "development" when running from a checkout.
TUNNELIO_REVISION = env("TUNNELIO_REVISION", "development") or "development"
