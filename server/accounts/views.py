"""
REST API for accounts (SPEC §11.2). Cookie sessions + CSRF (header X-CSRFToken). `password` is
the auth key the browser derives from the typed password (SPEC §10.1), never the password.

    GET    /api/auth/csrf                    sets the csrftoken cookie, returns the token
    POST   /api/auth/register                {email, password[, bot_check_token]}
    POST   /api/auth/verify-email            {email, code}                 (only when EMAIL_URL is set)
    POST   /api/auth/resend-code             {email[, bot_check_token]}    (only when EMAIL_URL is set)
    POST   /api/auth/login                   {email, password[, bot_check_token][, totp_code]}
    POST   /api/auth/logout
    GET    /api/auth/me
    POST   /api/auth/change-password         {current_password, new_password}   → disconnects everything
    DELETE /api/auth/account                 {password}
    POST   /api/auth/password-reset          {email[, bot_check_token]}    (only when EMAIL_URL is set)
    POST   /api/auth/password-reset/confirm  {email, code, new_password}   → disconnects everything
    POST   /api/auth/totp/setup              → {secret, otpauth_url}
    POST   /api/auth/totp/enable             {code}
    POST   /api/auth/totp/disable            {password, code}

"Disconnects everything" (SPEC §4.7, rev. 1.3): every device of the account is deleted (trays get
`revoked` and forget their pairings) and the synced pairings blob is removed. The user pairs
again with the code shown by the tray.
"""

from __future__ import annotations

from datetime import timedelta

from asgiref.sync import async_to_sync
from django.conf import settings
from django.contrib.auth import get_user_model, login, logout, update_session_auth_hash
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.mail import send_mail
from django.db import transaction
from django.middleware.csrf import get_token
from django.utils import timezone
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from preferences.models import PreferencesBlob

from . import bot_check, totp
from . import sessions as login_sessions
from .models import EmailCode, LoginSession, TotpSecret

User = get_user_model()

MAIL = {
    EmailCode.PURPOSE_VERIFY: (
        "Your Tunnelio code / Seu código do Tunnelio",
        """Code: {code}

Type this code in Tunnelio to confirm your e-mail. It expires in {minutes} minutes.
If you did not create an account, ignore this e-mail.

Digite este código no Tunnelio para confirmar seu e-mail. Ele vale por {minutes} minutos.
Se você não criou uma conta, ignore este e-mail.
""",
    ),
    EmailCode.PURPOSE_RESET: (
        "Your Tunnelio code / Seu código do Tunnelio",
        """Code: {code}

Use this code to choose a new Tunnelio password. It expires in {minutes} minutes.
If you did not ask for it, ignore this e-mail: your password stays the same.

Use este código para escolher uma nova senha do Tunnelio. Ele vale por {minutes} minutos.
Se você não pediu, ignore este e-mail: sua senha continua a mesma.
""",
    ),
}


def _error(code: str, message: str, http_status: int = 400) -> Response:
    return Response({"code": code, "message": message}, status=http_status)


def _password_errors(password: str, user=None) -> list[str] | None:
    try:
        validate_password(password, user)
    except ValidationError as exc:
        return list(exc.messages)
    return None


def _email_disabled() -> Response:
    return _error("E_EMAIL_DISABLED", "E-mail is not enabled on this server.", status.HTTP_404_NOT_FOUND)


def _send_code(user, purpose: str) -> None:
    """Issue and mail a code; silently does nothing past the hourly limit (no enumeration, no spam)."""
    code = EmailCode.issue(user, purpose)
    if code is None:
        return
    subject, body = MAIL[purpose]
    send_mail(subject, body.format(code=code, minutes=settings.EMAIL_CODE_TTL_MINUTES), settings.DEFAULT_FROM_EMAIL, [user.email])


def _disconnect_everything(user) -> None:
    """Password changed or reset: drop every device (trays get `revoked`) and the synced pairings."""
    from devices.models import Device
    from pairings.models import PairingsBlob
    from relay.services import disconnect_user_devices

    async_to_sync(disconnect_user_devices)(user.id, reason="revoked")
    Device.objects.filter(user=user).delete()
    PairingsBlob.objects.filter(user=user).delete()


def _totp_enabled(user) -> bool:
    t = getattr(user, "totp", None)
    return bool(t and t.confirmed)


@method_decorator(ensure_csrf_cookie, name="dispatch")
class CsrfView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        return Response({"csrfToken": get_token(request)})


@method_decorator(csrf_protect, name="dispatch")
class RegisterView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_scope = "register"

    def post(self, request):
        if not settings.REGISTRATION_ENABLED:
            return _error("E_REGISTRATION_CLOSED", "Registration is disabled.", status.HTTP_403_FORBIDDEN)
        email = User.objects.normalize(str(request.data.get("email", "")))
        password = str(request.data.get("password", ""))
        if not email or "@" not in email or len(email) > 254:
            return _error("E_INVALID", "A valid e-mail is required.")
        if not bot_check.verify(request.data.get("bot_check_token"), request.META.get("REMOTE_ADDR")):
            return _error("E_BOT_CHECK", "Human verification failed.")
        existing = User.objects.filter(email=email).first()
        if existing is not None and existing.is_active:
            return _error("E_EXISTS", "An account with this e-mail already exists.", status.HTTP_409_CONFLICT)
        if errors := _password_errors(password, User(email=email)):
            return Response({"code": "E_WEAK_PASSWORD", "message": " ".join(errors)}, status=400)
        if not settings.EMAIL_ENABLED:
            user = User.objects.create_user(email=email, password=password)
            login(request, user)
            return Response({"email": user.email}, status=status.HTTP_201_CREATED)
        # With e-mail: the account exists but is inactive until the code comes back. An earlier
        # unverified attempt with the same address is replaced.
        if existing is not None:
            existing.delete()
        user = User.objects.create_user(email=email, password=password, is_active=False)
        _send_code(user, EmailCode.PURPOSE_VERIFY)
        return Response({"email": user.email, "verification_required": True}, status=status.HTTP_202_ACCEPTED)


@method_decorator(csrf_protect, name="dispatch")
class VerifyEmailView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_scope = "verify"

    def post(self, request):
        if not settings.EMAIL_ENABLED:
            return _email_disabled()
        email = User.objects.normalize(str(request.data.get("email", "")))
        user = User.objects.filter(email=email, is_active=False).first()
        with transaction.atomic():
            if user is None or not EmailCode.consume(user, EmailCode.PURPOSE_VERIFY, str(request.data.get("code", ""))):
                return _error("E_BAD_CODE", "Wrong or expired code.")
            user.is_active = True
            user.save(update_fields=["is_active"])
        login(request, user)
        return Response({"email": user.email})


@method_decorator(csrf_protect, name="dispatch")
class ResendCodeView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_scope = "resend"

    def post(self, request):
        if not settings.EMAIL_ENABLED:
            return _email_disabled()
        if not bot_check.verify(request.data.get("bot_check_token"), request.META.get("REMOTE_ADDR")):
            return _error("E_BOT_CHECK", "Human verification failed.")
        email = User.objects.normalize(str(request.data.get("email", "")))
        user = User.objects.filter(email=email, is_active=False).first()
        if user is not None:
            _send_code(user, EmailCode.PURPOSE_VERIFY)
        return Response(status=status.HTTP_204_NO_CONTENT)  # never reveal whether the e-mail exists


@method_decorator(csrf_protect, name="dispatch")
class LoginView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_scope = "login"

    def post(self, request):
        email = User.objects.normalize(str(request.data.get("email", "")))
        password = str(request.data.get("password", ""))
        if not bot_check.verify(request.data.get("bot_check_token"), request.META.get("REMOTE_ADDR")):
            return _error("E_BOT_CHECK", "Human verification failed.")
        user = User.objects.filter(email=email).first()
        if user is None or not user.check_password(password):
            return _error("E_AUTH", "Invalid e-mail or password.", status.HTTP_401_UNAUTHORIZED)
        if not user.is_active:
            return Response({"code": "E_EMAIL_UNVERIFIED", "email": user.email}, status=status.HTTP_403_FORBIDDEN)
        if _totp_enabled(user):
            if err := self._check_totp(user, request.data.get("totp_code")):
                return err
        login(request, user)
        return Response({"email": user.email})

    @staticmethod
    def _check_totp(user, code) -> Response | None:
        t = user.totp
        if code in (None, ""):
            return _error("E_TOTP_REQUIRED", "Enter the code from your authenticator app.", status.HTTP_401_UNAUTHORIZED)
        now = timezone.now()
        if t.locked_until and t.locked_until > now:
            return _error("E_TOTP_LOCKED", "Too many wrong codes. Try again later.", status.HTTP_401_UNAUTHORIZED)
        step = totp.match_step(totp.decrypt_secret(t.secret_enc), str(code))
        if step is None or step <= t.last_step:
            t.failed_attempts += 1
            if t.failed_attempts >= settings.TOTP_MAX_FAILED:
                t.failed_attempts = 0
                t.locked_until = now + timedelta(minutes=settings.TOTP_LOCK_MINUTES)
            t.save(update_fields=["failed_attempts", "locked_until"])
            return _error("E_TOTP_INVALID", "Wrong code.", status.HTTP_401_UNAUTHORIZED)
        t.last_step, t.failed_attempts, t.locked_until = step, 0, None
        t.save(update_fields=["last_step", "failed_attempts", "locked_until"])
        return None


class LogoutView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        flags = {
            "registration_enabled": settings.REGISTRATION_ENABLED,
            "email_enabled": settings.EMAIL_ENABLED,
            "bot_check_site_key": settings.BOT_CHECK_SITE_KEY or None,
            "bot_check_script_url": settings.BOT_CHECK_SCRIPT_URL or None,
            "bot_check_global": settings.BOT_CHECK_GLOBAL or None,
        }
        if not request.user.is_authenticated:
            return Response({"authenticated": False, **flags})
        return Response(
            {
                "authenticated": True,
                "email": request.user.email,
                "created_at": request.user.created_at,
                "totp_enabled": _totp_enabled(request.user),
                **flags,
            }
        )


class SessionsView(APIView):
    """GET /api/auth/sessions — the account's signed-in browsers (SPEC §11.2), newest use first."""

    def get(self, request):
        current = request.session.session_key
        return Response(
            [
                {
                    "id": s.pk,
                    "browser": s.browser,
                    "os": s.os,
                    "device": s.device,
                    "created_at": s.created_at,
                    "last_seen_at": s.last_seen_at,
                    "current": s.session_key == current,
                }
                for s in login_sessions.live_sessions(request.user)
            ]
        )


class SessionDetailView(APIView):
    """DELETE /api/auth/sessions/{id} — sign that browser out (this one too, when it is the current)."""

    throttle_scope = "sessions"

    def delete(self, request, pk: int):
        row = LoginSession.objects.filter(user=request.user, pk=pk).first()
        if row is None:
            return _error("E_NOT_FOUND", "No such session.", status.HTTP_404_NOT_FOUND)
        if row.session_key == request.session.session_key:
            logout(request)
        else:
            login_sessions.revoke([row.session_key])
        return Response(status=status.HTTP_204_NO_CONTENT)


class LogoutAllView(APIView):
    """POST /api/auth/sessions/logout-all — sign out every browser of the account, this one included."""

    throttle_scope = "sessions"

    def post(self, request):
        keys = login_sessions.user_session_keys(request.user)
        keys.discard(request.session.session_key)
        login_sessions.revoke(keys)
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class ChangePasswordView(APIView):
    throttle_scope = "change_password"

    def post(self, request):
        current = str(request.data.get("current_password", ""))
        new = str(request.data.get("new_password", ""))
        if not request.user.check_password(current):
            return _error("E_AUTH", "Current password is wrong.", status.HTTP_401_UNAUTHORIZED)
        if errors := _password_errors(new, request.user):
            return Response({"code": "E_WEAK_PASSWORD", "message": " ".join(errors)}, status=400)
        this_key = request.session.session_key
        others = login_sessions.user_session_keys(request.user) - {this_key}
        request.user.set_password(new)
        request.user.save(update_fields=["password"])
        update_session_auth_hash(request, request.user)  # keeps this session (under a new key)
        login_sessions.rekey(this_key, request.session.session_key)  # this browser keeps its row and socket
        login_sessions.revoke(others)  # the others: rows gone, their relay sockets closed now
        _disconnect_everything(request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


class DeleteAccountView(APIView):
    throttle_scope = "delete_account"

    def delete(self, request):
        from relay.services import disconnect_user_devices

        if not request.user.check_password(str(request.data.get("password", ""))):
            return _error("E_AUTH", "Password is wrong.", status.HTTP_401_UNAUTHORIZED)
        user = request.user
        async_to_sync(disconnect_user_devices)(user.id, reason="account_deleted")
        login_sessions.revoke(login_sessions.user_session_keys(user) - {request.session.session_key})
        logout(request)
        user.delete()  # cascades: devices, pairing sessions, pairings blob, codes, totp, relay logs
        return Response(status=status.HTTP_204_NO_CONTENT)


@method_decorator(csrf_protect, name="dispatch")
class PasswordResetRequestView(APIView):
    """Sends a 6-digit code (SPEC §11.2). Always 204: never reveals whether the e-mail exists."""

    permission_classes = [permissions.AllowAny]
    throttle_scope = "reset"

    def post(self, request):
        if not settings.EMAIL_ENABLED:
            return _email_disabled()
        if not bot_check.verify(request.data.get("bot_check_token"), request.META.get("REMOTE_ADDR")):
            return _error("E_BOT_CHECK", "Human verification failed.")
        email = User.objects.normalize(str(request.data.get("email", "")))
        user = User.objects.filter(email=email, is_active=True).first()
        if user is not None:
            _send_code(user, EmailCode.PURPOSE_RESET)
        return Response(status=status.HTTP_204_NO_CONTENT)


@method_decorator(csrf_protect, name="dispatch")
class PasswordResetConfirmView(APIView):
    """{email, code, new_password} → 204 and everything disconnected; the second factor is turned
    off (losing the authenticator app is recovered this way). Wrong/expired/used code → E_BAD_CODE."""

    permission_classes = [permissions.AllowAny]
    throttle_scope = "reset"

    def post(self, request):
        if not settings.EMAIL_ENABLED:
            return _email_disabled()
        email = User.objects.normalize(str(request.data.get("email", "")))
        user = User.objects.filter(email=email, is_active=True).first()
        with transaction.atomic():
            if user is None or not EmailCode.consume(user, EmailCode.PURPOSE_RESET, str(request.data.get("code", ""))):
                return _error("E_BAD_CODE", "Wrong or expired code.")
            new = str(request.data.get("new_password", ""))
            if errors := _password_errors(new, user):
                return Response({"code": "E_WEAK_PASSWORD", "message": " ".join(errors)}, status=400)
            user.set_password(new)  # every existing session stops validating (session auth hash changes)
            user.save(update_fields=["password"])
            TotpSecret.objects.filter(user=user).delete()
            # The preferences were sealed with a key derived from the old password: nobody can open them.
            PreferencesBlob.objects.filter(user=user).delete()
        login_sessions.revoke(login_sessions.user_session_keys(user))
        _disconnect_everything(user)
        return Response(status=status.HTTP_204_NO_CONTENT)


class TotpSetupView(APIView):
    """Start enrolment: a new seed, not active until `enable` sees one valid code."""

    throttle_scope = "totp"

    def post(self, request):
        if _totp_enabled(request.user):
            return _error("E_TOTP_ENABLED", "Two-step sign-in is already on.", status.HTTP_409_CONFLICT)
        secret = totp.new_secret()
        TotpSecret.objects.update_or_create(
            user=request.user,
            defaults={
                "secret_enc": totp.encrypt_secret(secret),
                "confirmed": False,
                "last_step": 0,
                "failed_attempts": 0,
                "locked_until": None,
            },
        )
        return Response({"secret": secret, "otpauth_url": totp.provisioning_uri(secret, request.user.email)})


class TotpEnableView(APIView):
    throttle_scope = "totp"

    def post(self, request):
        t = TotpSecret.objects.filter(user=request.user, confirmed=False).first()
        if t is None:
            return _error("E_TOTP_NOT_PENDING", "Start the setup first.", status.HTTP_409_CONFLICT)
        step = totp.match_step(totp.decrypt_secret(t.secret_enc), str(request.data.get("code", "")))
        if step is None:
            return _error("E_BAD_CODE", "Wrong code.")
        t.confirmed, t.last_step = True, step
        t.save(update_fields=["confirmed", "last_step"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class TotpDisableView(APIView):
    throttle_scope = "totp"

    def post(self, request):
        if not request.user.check_password(str(request.data.get("password", ""))):
            return _error("E_AUTH", "Password is wrong.", status.HTTP_401_UNAUTHORIZED)
        t = TotpSecret.objects.filter(user=request.user).first()
        if t is None:
            return _error("E_TOTP_DISABLED", "Two-step sign-in is off.", status.HTTP_409_CONFLICT)
        if t.confirmed and totp.match_step(totp.decrypt_secret(t.secret_enc), str(request.data.get("code", ""))) is None:
            return _error("E_BAD_CODE", "Wrong code.")
        t.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
