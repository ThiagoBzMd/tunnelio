"""
accounts — email + password (Argon2PasswordHasher), cookie sessions, account deletion.

The user model is intentionally minimal (SPEC §11.1): the server stores nothing about a
person beyond what authentication needs. E-mails are stored lower-cased so lookups are
case-insensitive. Account deletion cascades to devices, pairing sessions, the pairings blob,
e-mail codes, the second factor and relay logs (SPEC §11.2).
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

from django.conf import settings
from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.contrib.auth.models import PermissionsMixin
from django.db import models


class UserManager(BaseUserManager):
    use_in_migrations = True

    @staticmethod
    def normalize(email: str) -> str:
        return BaseUserManager.normalize_email(email or "").strip().lower()

    def _create(self, email: str, password: str | None, **extra):
        email = self.normalize(email)
        if not email:
            raise ValueError("email is required")
        user = self.model(email=email, **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email: str, password: str | None = None, **extra):
        extra.setdefault("is_staff", False)
        extra.setdefault("is_superuser", False)
        return self._create(email, password, **extra)

    def create_superuser(self, email: str, password: str | None = None, **extra):
        extra["is_staff"] = True
        extra["is_superuser"] = True
        return self._create(email, password, **extra)

    def get_by_natural_key(self, username):
        return self.get(email=self.normalize(username))


class User(AbstractBaseUser, PermissionsMixin):
    email = models.EmailField(unique=True)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = UserManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS: list[str] = []

    class Meta:
        db_table = "accounts_user"

    def save(self, *args, **kwargs):
        self.email = UserManager.normalize(self.email)
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return self.email


class EmailCode(models.Model):
    """A 6-digit code e-mailed to prove ownership of the address: `verify` activates a new account,
    `reset` lets the user choose a new password (SPEC §11.2). Only an HMAC of the code is stored; a
    new code replaces the previous one; it expires and burns after too many wrong tries."""

    PURPOSE_VERIFY = "verify"
    PURPOSE_RESET = "reset"
    PURPOSES = [(PURPOSE_VERIFY, "verify e-mail"), (PURPOSE_RESET, "password reset")]

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="email_codes")
    purpose = models.CharField(max_length=8, choices=PURPOSES)
    code_hash = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    attempts = models.PositiveSmallIntegerField(default=0)
    used = models.BooleanField(default=False)

    class Meta:
        db_table = "accounts_email_code"
        indexes = [models.Index(fields=["user", "purpose", "created_at"])]

    def __str__(self) -> str:
        return f"{self.purpose} code for user {self.user_id} (expires {self.expires_at:%Y-%m-%d %H:%M})"

    @staticmethod
    def hash(user_id: int, purpose: str, code: str) -> str:
        msg = f"tunnelio/email-code/v1:{purpose}:{user_id}:{code}".encode()
        return hmac.new(settings.SECRET_KEY.encode(), msg, hashlib.sha256).hexdigest()

    def matches(self, code: str) -> bool:
        return hmac.compare_digest(self.code_hash, self.hash(self.user_id, self.purpose, code))

    @classmethod
    def issue(cls, user: User, purpose: str) -> str | None:
        """Create a fresh code (replacing older ones); None when the hourly limit is reached."""
        from datetime import timedelta

        from django.utils import timezone

        now = timezone.now()
        recent = cls.objects.filter(user=user, purpose=purpose, created_at__gte=now - timedelta(hours=1)).count()
        if recent >= settings.EMAIL_CODES_PER_HOUR:
            return None
        cls.objects.filter(user=user, purpose=purpose, used=False).update(used=True)
        code = f"{secrets.randbelow(10**6):06d}"
        cls.objects.create(
            user=user,
            purpose=purpose,
            code_hash=cls.hash(user.pk, purpose, code),
            expires_at=now + timedelta(minutes=settings.EMAIL_CODE_TTL_MINUTES),
        )
        return code

    @classmethod
    def consume(cls, user: User, purpose: str, code: str) -> bool:
        """True and all codes of that purpose deleted when `code` is the live one; wrong tries are
        counted and the code burns after EMAIL_CODE_MAX_ATTEMPTS. Call inside a transaction."""
        from django.utils import timezone

        code = (code or "").strip().replace(" ", "")
        if len(code) != 6 or not code.isdigit():
            return False
        entry = (
            cls.objects.select_for_update()
            .filter(user=user, purpose=purpose, used=False, expires_at__gt=timezone.now())
            .order_by("-created_at")
            .first()
        )
        if entry is None:
            return False
        if not entry.matches(code):
            entry.attempts += 1
            entry.used = entry.attempts >= settings.EMAIL_CODE_MAX_ATTEMPTS
            entry.save(update_fields=["attempts", "used"])
            return False
        cls.objects.filter(user=user, purpose=purpose).delete()
        return True


class TotpSecret(models.Model):
    """Optional second factor (authenticator app). `confirmed` becomes true after the first valid
    code; until then the row is a pending enrolment. Seed encrypted at rest (accounts.totp)."""

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="totp")
    secret_enc = models.TextField()
    confirmed = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    last_step = models.BigIntegerField(default=0)  # anti-replay: a code is accepted once
    failed_attempts = models.PositiveSmallIntegerField(default=0)
    locked_until = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "accounts_totp_secret"

    def __str__(self) -> str:
        return f"totp of user {self.user_id} ({'on' if self.confirmed else 'pending'})"


class LoginSession(models.Model):
    """
    One signed-in browser (a Django session), for Settings → Account → Active sessions. Only what
    the browser announces about itself (browser, system, kind of device) and dates: no IP, no place.
    Created at sign-in (or on the first request of a session older than this table), touched at most
    every few minutes, deleted with the session (sign-out, "Sign out" in the list, password change).
    `session_key` is a credential: never shown, not even in the admin.
    """

    COMPUTER, PHONE, TABLET, OTHER = "computer", "phone", "tablet", "other"
    DEVICES = [(COMPUTER, "computer"), (PHONE, "phone"), (TABLET, "tablet"), (OTHER, "other")]

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="login_sessions")
    session_key = models.CharField(max_length=64, unique=True)
    browser = models.CharField(max_length=32, blank=True)
    os = models.CharField(max_length=32, blank=True)
    device = models.CharField(max_length=16, choices=DEVICES, default=OTHER)
    created_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField()

    class Meta:
        db_table = "accounts_login_session"
        indexes = [models.Index(fields=["user", "-last_seen_at"])]

    def __str__(self) -> str:
        return f"{self.browser or '?'} on {self.os or '?'} ({self.device}) of {self.user_id}"
