"""TOTP (RFC 6238) second factor with the standard library only: 6 digits, 30 s steps, ±1 step of
clock drift. The seed is stored encrypted at rest (Fernet keyed from SECRET_KEY), so a database
dump alone does not yield usable seeds. Anti-replay: the caller keeps the last accepted step and
refuses anything at or below it."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings

STEP_SECONDS = 30
DIGITS = 6
DRIFT_STEPS = 1
SECRET_BYTES = 20


def new_secret() -> str:
    """Base32 seed (160 bits), the form authenticator apps accept."""
    return base64.b32encode(secrets.token_bytes(SECRET_BYTES)).decode("ascii")


def provisioning_uri(secret: str, email: str) -> str:
    issuer = quote(settings.TOTP_ISSUER, safe="")
    label = f"{issuer}:{quote(email, safe='')}"
    query = f"secret={secret}&issuer={issuer}&algorithm=SHA1&digits={DIGITS}&period={STEP_SECONDS}"
    return f"otpauth://totp/{label}?{query}"


def code_at(secret: str, step: int) -> str:
    key = base64.b32decode(secret.upper() + "=" * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return f"{value % (10**DIGITS):0{DIGITS}d}"


def current_step(now: float | None = None) -> int:
    return int(now if now is not None else time.time()) // STEP_SECONDS


def match_step(secret: str, code: str, now: float | None = None) -> int | None:
    """The step whose code equals `code` within the drift window, else None."""
    code = (code or "").strip().replace(" ", "")
    if len(code) != DIGITS or not code.isdigit() or not secret:
        return None
    base = current_step(now)
    for delta in range(-DRIFT_STEPS, DRIFT_STEPS + 1):
        step = base + delta
        if hmac.compare_digest(code_at(secret, step), code):
            return step
    return None


def _fernet() -> Fernet:
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(settings.SECRET_KEY.encode()).digest()))


def encrypt_secret(secret: str) -> str:
    return _fernet().encrypt(secret.encode()).decode()


def decrypt_secret(token: str) -> str:
    """'' when the token is corrupt or SECRET_KEY changed (verification then fails closed)."""
    try:
        return _fernet().decrypt(token.encode()).decode()
    except (InvalidToken, ValueError, TypeError):
        return ""
