"""REST tests for accounts (SPEC §11.2): CSRF, registration (+ e-mail verification), login (+ second
factor), password change/reset (disconnect everything), deletion."""

from __future__ import annotations

import time
from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.core import mail
from django.test import Client
from django.utils import timezone

from accounts import totp
from accounts.models import EmailCode, TotpSecret
from devices.models import Device, new_device_token
from pairings.models import PairingsBlob

User = get_user_model()
pytestmark = pytest.mark.django_db
PASSWORD = "correct horse battery staple"
JSON = "application/json"


def csrf_client():
    """A client that enforces CSRF (like a browser) + a header factory that follows token rotation
    (Django rotates the csrftoken cookie on login, so the header must be re-read per request)."""
    c = Client(enforce_csrf_checks=True)
    c.get("/api/auth/csrf")
    return c, lambda: {"HTTP_X_CSRFTOKEN": c.cookies["csrftoken"].value}


def code_from_mail(i: int = -1) -> str:
    line = next(ln for ln in mail.outbox[i].body.splitlines() if ln.startswith("Code: "))
    return line.split(": ", 1)[1].strip()


def give_device_and_pairings(user):
    _, token_hash = new_device_token()
    Device.objects.create(user=user, name="pc", token_hash=token_hash)
    PairingsBlob.objects.create(user=user, timestamp="2026-10-08T00:00:00Z", ciphertext=b"x" * 40, size=40)


def test_register_login_me_logout():
    c, h = csrf_client()
    r = c.post("/api/auth/register", {"email": "Alice@Example.com", "password": PASSWORD}, content_type=JSON, **h())
    assert r.status_code == 201 and r.json() == {"email": "alice@example.com"}
    me = c.get("/api/auth/me").json()
    assert me["authenticated"] and me["email"] == "alice@example.com" and me["totp_enabled"] is False
    assert "has_vault" not in me
    assert c.post("/api/auth/logout", **h()).status_code == 204
    assert c.get("/api/auth/me").json()["authenticated"] is False
    r = c.post("/api/auth/login", {"email": "ALICE@example.com", "password": PASSWORD}, content_type=JSON, **h())
    assert r.status_code == 200
    r = c.post("/api/auth/login", {"email": "alice@example.com", "password": "wrong"}, content_type=JSON, **h())
    assert r.status_code == 401 and r.json()["code"] == "E_AUTH"


def test_register_requires_csrf_and_strong_password():
    c = Client(enforce_csrf_checks=True)
    r = c.post("/api/auth/register", {"email": "a@b.c", "password": PASSWORD}, content_type=JSON)
    assert r.status_code == 403
    c, h = csrf_client()
    r = c.post("/api/auth/register", {"email": "a@b.c", "password": "short"}, content_type=JSON, **h())
    assert r.status_code == 400 and r.json()["code"] == "E_WEAK_PASSWORD"
    r = c.post("/api/auth/register", {"email": "not-an-email", "password": PASSWORD}, content_type=JSON, **h())
    assert r.status_code == 400
    User.objects.create_user("dup@example.com", PASSWORD)
    r = c.post("/api/auth/register", {"email": "DUP@example.com", "password": PASSWORD}, content_type=JSON, **h())
    assert r.status_code == 409


def test_registration_can_be_closed(settings):
    settings.REGISTRATION_ENABLED = False
    c, h = csrf_client()
    r = c.post("/api/auth/register", {"email": "a@b.c", "password": PASSWORD}, content_type=JSON, **h())
    assert r.status_code == 403 and r.json()["code"] == "E_REGISTRATION_CLOSED"
    assert c.get("/api/auth/me").json()["registration_enabled"] is False


def test_password_is_argon2():
    from tunnelio.settings import base  # test settings swap in MD5 for speed

    assert base.PASSWORD_HASHERS[0].endswith("Argon2PasswordHasher")


def test_email_verification_flow(settings):
    settings.EMAIL_ENABLED = True
    c, h = csrf_client()
    post = lambda url, body: c.post(url, body, content_type=JSON, **h())  # noqa: E731

    # Verification and resend are 404 without e-mail; with it, register creates an inactive account.
    r = post("/api/auth/register", {"email": "new@example.com", "password": PASSWORD})
    assert r.status_code == 202 and r.json() == {"email": "new@example.com", "verification_required": True}
    assert c.get("/api/auth/me").json()["authenticated"] is False  # not signed in yet
    user = User.objects.get(email="new@example.com")
    assert user.is_active is False and len(mail.outbox) == 1 and mail.outbox[0].to == ["new@example.com"]
    code = code_from_mail()
    assert len(code) == 6 and code.isdigit()
    assert code not in EmailCode.objects.get(user=user).code_hash  # only an HMAC is stored

    # Login before verifying tells the browser to go to the code screen (right password only).
    r = post("/api/auth/login", {"email": "new@example.com", "password": PASSWORD})
    assert r.status_code == 403 and r.json() == {"code": "E_EMAIL_UNVERIFIED", "email": "new@example.com"}
    r = post("/api/auth/login", {"email": "new@example.com", "password": "wrong password"})
    assert r.status_code == 401 and r.json()["code"] == "E_AUTH"

    # Registering again with the same address replaces the pending account and sends a new code.
    r = post("/api/auth/register", {"email": "New@Example.com", "password": PASSWORD})
    assert r.status_code == 202 and len(mail.outbox) == 2
    assert not User.objects.filter(pk=user.pk).exists()
    user = User.objects.get(email="new@example.com")
    old, code = code, code_from_mail()

    # Wrong / stale code, then the right one signs the browser in.
    wrong = "000000" if code != "000000" else "111111"
    r = post("/api/auth/verify-email", {"email": "new@example.com", "code": wrong})
    assert r.status_code == 400 and r.json()["code"] == "E_BAD_CODE"
    if old != code:
        assert post("/api/auth/verify-email", {"email": "new@example.com", "code": old}).json()["code"] == "E_BAD_CODE"
    r = post("/api/auth/verify-email", {"email": "new@example.com", "code": code})
    assert r.status_code == 200 and r.json() == {"email": "new@example.com"}
    assert c.get("/api/auth/me").json()["authenticated"] is True
    user.refresh_from_db()
    assert user.is_active and EmailCode.objects.filter(user=user).count() == 0
    # The code is single-use and verify-email ignores active accounts.
    assert post("/api/auth/verify-email", {"email": "new@example.com", "code": code}).json()["code"] == "E_BAD_CODE"
    # A verified account registers normally with E_EXISTS.
    assert post("/api/auth/register", {"email": "new@example.com", "password": PASSWORD}).status_code == 409


def test_resend_code_limits(settings):
    settings.EMAIL_ENABLED = True
    c, h = csrf_client()
    post = lambda url, body: c.post(url, body, content_type=JSON, **h())  # noqa: E731
    assert post("/api/auth/register", {"email": "p@example.com", "password": PASSWORD}).status_code == 202
    # Unknown / active addresses: same 204, no mail.
    assert post("/api/auth/resend-code", {"email": "nobody@example.com"}).status_code == 204
    assert len(mail.outbox) == 1
    # Two resends reach the 3/hour limit; the 4th request is 204 but sends nothing.
    assert post("/api/auth/resend-code", {"email": "p@example.com"}).status_code == 204
    assert post("/api/auth/resend-code", {"email": "p@example.com"}).status_code == 204
    assert len(mail.outbox) == 3
    assert post("/api/auth/resend-code", {"email": "p@example.com"}).status_code == 204
    assert len(mail.outbox) == 3
    # The newest code is the live one; older ones are dead.
    first, last = code_from_mail(0), code_from_mail(-1)
    if first != last:
        assert post("/api/auth/verify-email", {"email": "p@example.com", "code": first}).json()["code"] == "E_BAD_CODE"
    # 5 wrong attempts burn the code.
    wrong = "000000" if last != "000000" else "111111"
    for _ in range(5):
        assert post("/api/auth/verify-email", {"email": "p@example.com", "code": wrong}).json()["code"] == "E_BAD_CODE"
    assert post("/api/auth/verify-email", {"email": "p@example.com", "code": last}).json()["code"] == "E_BAD_CODE"
    # Expired codes fail.
    user = User.objects.get(email="p@example.com")
    EmailCode.objects.all().delete()
    EmailCode.objects.create(
        user=user,
        purpose=EmailCode.PURPOSE_VERIFY,
        code_hash=EmailCode.hash(user.pk, EmailCode.PURPOSE_VERIFY, "424242"),
        expires_at=timezone.now() - timedelta(seconds=1),
    )
    assert post("/api/auth/verify-email", {"email": "p@example.com", "code": "424242"}).json()["code"] == "E_BAD_CODE"


def test_change_password_keeps_session_but_disconnects_everything():
    user = User.objects.create_user("a@example.com", PASSWORD)
    give_device_and_pairings(user)
    c, h = csrf_client()
    c.force_login(user)
    other = Client()
    other.force_login(user)
    r = c.post(
        "/api/auth/change-password",
        {"current_password": "nope", "new_password": "another strong one 42"},
        content_type=JSON,
        **h(),
    )
    assert r.status_code == 401
    assert Device.objects.filter(user=user).count() == 1  # a failed attempt changes nothing
    r = c.post(
        "/api/auth/change-password",
        {"current_password": PASSWORD, "new_password": "another strong one 42"},
        content_type=JSON,
        **h(),
    )
    assert r.status_code == 204
    assert c.get("/api/auth/me").json()["authenticated"] is True
    assert other.get("/api/auth/me").json()["authenticated"] is False
    user.refresh_from_db()
    assert user.check_password("another strong one 42")
    assert Device.objects.filter(user=user).count() == 0 and PairingsBlob.objects.filter(user=user).count() == 0


def test_delete_account_cascades():
    user = User.objects.create_user("a@example.com", PASSWORD)
    give_device_and_pairings(user)
    EmailCode.issue(user, EmailCode.PURPOSE_RESET)
    TotpSecret.objects.create(user=user, secret_enc=totp.encrypt_secret(totp.new_secret()), confirmed=True)
    c, h = csrf_client()
    c.force_login(user)
    assert c.delete("/api/auth/account", {"password": "wrong"}, content_type=JSON, **h()).status_code == 401
    assert c.delete("/api/auth/account", {"password": PASSWORD}, content_type=JSON, **h()).status_code == 204
    assert not User.objects.filter(email="a@example.com").exists()
    assert Device.objects.count() == 0 and PairingsBlob.objects.count() == 0
    assert EmailCode.objects.count() == 0 and TotpSecret.objects.count() == 0
    assert c.get("/api/auth/me").json()["authenticated"] is False


def test_password_reset_only_when_email_enabled():
    User.objects.create_user("a@example.com", PASSWORD)
    c, h = csrf_client()
    r = c.post("/api/auth/password-reset", {"email": "a@example.com"}, content_type=JSON, **h())
    assert r.status_code == 404
    body = {"email": "a@example.com", "code": "123456", "new_password": "x" * 43}
    assert c.post("/api/auth/password-reset/confirm", body, content_type=JSON, **h()).status_code == 404
    assert c.post("/api/auth/verify-email", body, content_type=JSON, **h()).status_code == 404
    assert c.post("/api/auth/resend-code", body, content_type=JSON, **h()).status_code == 404
    assert len(mail.outbox) == 0


def test_password_reset_with_code_disconnects_everything(settings):
    settings.EMAIL_ENABLED = True
    user = User.objects.create_user("a@example.com", PASSWORD)
    give_device_and_pairings(user)
    TotpSecret.objects.create(user=user, secret_enc=totp.encrypt_secret(totp.new_secret()), confirmed=True)
    c, h = csrf_client()
    post = lambda url, body: c.post(url, body, content_type=JSON, **h())  # noqa: E731

    # Unknown e-mail: same 204, no mail. Unverified accounts cannot reset either.
    assert post("/api/auth/password-reset", {"email": "nobody@example.com"}).status_code == 204
    assert len(mail.outbox) == 0
    assert post("/api/auth/password-reset", {"email": " A@Example.com "}).status_code == 204
    assert len(mail.outbox) == 1 and mail.outbox[0].to == ["a@example.com"]
    code = code_from_mail()

    new_key = "n" * 43  # the browser sends the derived auth key, never the typed password
    confirm = lambda code, email="a@example.com": post(  # noqa: E731
        "/api/auth/password-reset/confirm", {"email": email, "code": code, "new_password": new_key}
    )
    wrong = "000000" if code != "000000" else "111111"
    r = confirm(wrong)
    assert r.status_code == 400 and r.json()["code"] == "E_BAD_CODE"
    assert confirm(code, email="nobody@example.com").json()["code"] == "E_BAD_CODE"
    assert confirm("12ab56").json()["code"] == "E_BAD_CODE"
    assert Device.objects.filter(user=user).count() == 1  # nothing happened yet

    # A session opened before the reset stops working after it.
    other = Client()
    other.force_login(user)
    assert other.get("/api/auth/me").json()["authenticated"] is True

    assert confirm(code).status_code == 204
    user.refresh_from_db()
    assert user.check_password(new_key) and not user.check_password(PASSWORD)
    assert other.get("/api/auth/me").json()["authenticated"] is False
    assert Device.objects.filter(user=user).count() == 0 and PairingsBlob.objects.filter(user=user).count() == 0
    assert TotpSecret.objects.filter(user=user).count() == 0  # losing the authenticator is recovered by e-mail
    assert confirm(code).json()["code"] == "E_BAD_CODE"  # single use
    assert EmailCode.objects.filter(user=user).count() == 0
    # Signing in with the new password works, without a second factor.
    r = post("/api/auth/login", {"email": "a@example.com", "password": new_key})
    assert r.status_code == 200


def test_password_reset_code_limits(settings):
    settings.EMAIL_ENABLED = True
    user = User.objects.create_user("a@example.com", PASSWORD)
    c, h = csrf_client()
    post = lambda url, body: c.post(url, body, content_type=JSON, **h())  # noqa: E731
    confirm = lambda code: post(  # noqa: E731
        "/api/auth/password-reset/confirm", {"email": "a@example.com", "code": code, "new_password": "n" * 43}
    )
    post("/api/auth/password-reset", {"email": "a@example.com"})
    first = code_from_mail()
    post("/api/auth/password-reset", {"email": "a@example.com"})
    second = code_from_mail()
    if first != second:
        assert confirm(first).json()["code"] == "E_BAD_CODE"  # a new code replaces the previous one
    post("/api/auth/password-reset", {"email": "a@example.com"})
    assert len(mail.outbox) == 3
    assert post("/api/auth/password-reset", {"email": "a@example.com"}).status_code == 204
    assert len(mail.outbox) == 3  # 3 per hour
    good = code_from_mail()
    wrong = "000000" if good != "000000" else "111111"
    for _ in range(5):
        assert confirm(wrong).json()["code"] == "E_BAD_CODE"
    assert confirm(good).json()["code"] == "E_BAD_CODE"  # burned
    user.refresh_from_db()
    assert user.check_password(PASSWORD)


def test_totp_second_factor():
    user = User.objects.create_user("a@example.com", PASSWORD)
    c, h = csrf_client()
    c.force_login(user)
    post = lambda url, body=None: c.post(url, body or {}, content_type=JSON, **h())  # noqa: E731

    r = post("/api/auth/totp/setup")
    assert r.status_code == 200
    secret, uri = r.json()["secret"], r.json()["otpauth_url"]
    assert uri.startswith("otpauth://totp/Tunnelio:a%40example.com?secret=" + secret) and "issuer=Tunnelio" in uri
    assert secret not in TotpSecret.objects.get(user=user).secret_enc  # encrypted at rest
    assert c.get("/api/auth/me").json()["totp_enabled"] is False  # pending until confirmed
    now = time.time()
    good = totp.code_at(secret, totp.current_step(now))
    wrong = totp.code_at(secret, totp.current_step(now) + 5)
    assert post("/api/auth/totp/enable", {"code": wrong}).json()["code"] == "E_BAD_CODE"
    assert post("/api/auth/totp/enable", {"code": good}).status_code == 204
    assert c.get("/api/auth/me").json()["totp_enabled"] is True
    assert post("/api/auth/totp/setup").status_code == 409  # already on

    # Login now needs a code: missing → E_TOTP_REQUIRED, wrong → E_TOTP_INVALID, replayed → invalid.
    assert post("/api/auth/logout").status_code == 204
    login = lambda **extra: post("/api/auth/login", {"email": "a@example.com", "password": PASSWORD, **extra})  # noqa: E731
    r = login()
    assert r.status_code == 401 and r.json()["code"] == "E_TOTP_REQUIRED"
    r = login(totp_code=wrong)
    assert r.status_code == 401 and r.json()["code"] == "E_TOTP_INVALID"
    assert login(totp_code=good).json()["code"] == "E_TOTP_INVALID"  # the enrolment code was already used (anti-replay)
    t = TotpSecret.objects.get(user=user)
    t.last_step = 0
    t.save()
    assert login(totp_code=good).status_code == 200
    assert c.get("/api/auth/me").json()["totp_enabled"] is True

    # Disable needs the password and a valid (fresh) code.
    t.last_step = 0
    t.save()
    assert post("/api/auth/totp/disable", {"password": "wrong", "code": good}).status_code == 401
    assert post("/api/auth/totp/disable", {"password": PASSWORD, "code": wrong}).json()["code"] == "E_BAD_CODE"
    assert post("/api/auth/totp/disable", {"password": PASSWORD, "code": good}).status_code == 204
    assert c.get("/api/auth/me").json()["totp_enabled"] is False
    assert post("/api/auth/logout").status_code == 204
    assert login().status_code == 200


def test_totp_lockout(settings):
    settings.TOTP_MAX_FAILED = 3
    user = User.objects.create_user("a@example.com", PASSWORD)
    secret = totp.new_secret()
    TotpSecret.objects.create(user=user, secret_enc=totp.encrypt_secret(secret), confirmed=True)
    c, h = csrf_client()
    login = lambda code: c.post(  # noqa: E731
        "/api/auth/login", {"email": "a@example.com", "password": PASSWORD, "totp_code": code}, content_type=JSON, **h()
    )
    good = totp.code_at(secret, totp.current_step())
    wrong = totp.code_at(secret, totp.current_step() + 7)
    for _ in range(3):
        assert login(wrong).json()["code"] == "E_TOTP_INVALID"
    assert login(good).json()["code"] == "E_TOTP_LOCKED"
    t = TotpSecret.objects.get(user=user)
    t.locked_until = timezone.now() - timedelta(seconds=1)
    t.save()
    assert login(good).status_code == 200


def test_totp_helpers_match_rfc6238():
    # RFC 6238 Appendix B, SHA-1, seed "12345678901234567890", T = 59 s → 94287082.
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
    assert totp.code_at(secret, 59 // 30).endswith("287082")
    assert totp.match_step(secret, "287082", now=59) == 1
    assert totp.match_step(secret, "287082", now=59 + 3 * 30) is None  # outside ±1 step
    assert totp.match_step(secret, "28708", now=59) is None
    assert totp.decrypt_secret("garbage") == ""
    assert totp.decrypt_secret(totp.encrypt_secret(secret)) == secret


def test_bot_check_blocks_when_enabled(settings, monkeypatch):
    assert Client().get("/api/auth/me").json()["bot_check_script_url"] is None  # off by default
    settings.BOT_CHECK_SECRET_KEY = "secret"
    settings.BOT_CHECK_SITE_KEY = "site"
    settings.BOT_CHECK_SCRIPT_URL = "https://captcha.example/api.js"
    settings.BOT_CHECK_GLOBAL = "captcha"
    flags = Client().get("/api/auth/me").json()  # the browser learns where the widget comes from
    assert flags["bot_check_site_key"] == "site" and flags["bot_check_script_url"] == "https://captcha.example/api.js"
    assert flags["bot_check_global"] == "captcha"
    monkeypatch.setattr("accounts.bot_check.verify", lambda token, ip=None: token == "good")
    c, h = csrf_client()
    r = c.post(
        "/api/auth/register",
        {"email": "t@example.com", "password": PASSWORD, "bot_check_token": "bad"},
        content_type="application/json",
        **h(),
    )
    assert r.status_code == 400 and r.json()["code"] == "E_BOT_CHECK"
    r = c.post(
        "/api/auth/register",
        {"email": "t@example.com", "password": PASSWORD, "bot_check_token": "good"},
        content_type="application/json",
        **h(),
    )
    assert r.status_code == 201


def test_healthz_and_spa_fallback(settings, tmp_path):
    c = Client()
    assert c.get("/healthz").json() == {"status": "ok"}
    settings.WEB_DIST_DIR = tmp_path
    assert c.get("/chat/abc").status_code == 503  # not built
    (tmp_path / "index.html").write_text("<html>spa</html>")
    settings.DEBUG = True
    assert c.get("/chat/abc").content == b"<html>spa</html>"
    assert c.get("/api/nope").status_code == 404


def test_client_ip_comes_from_the_named_header(settings, rf):
    from tunnelio.middleware import ClientIPMiddleware

    seen = {}
    mw = ClientIPMiddleware(lambda req: seen.setdefault("ip", req.META["REMOTE_ADDR"]))
    forged = {"HTTP_X_FORWARDED_FOR": "6.6.6.6", "REMOTE_ADDR": "172.18.0.3"}

    settings.CLIENT_IP_HEADER = ""
    mw(rf.get("/", HTTP_X_VISITOR_IP="203.0.113.7", **forged))
    assert seen.pop("ip") == "172.18.0.3"  # none named (dev, self-host): the header is ignored

    settings.CLIENT_IP_HEADER = "X-Visitor-IP"
    mw(rf.get("/", HTTP_X_VISITOR_IP="203.0.113.7", **forged))
    assert seen.pop("ip") == "203.0.113.7"
    mw(rf.get("/", HTTP_X_VISITOR_IP="not-an-ip", **forged))
    assert seen.pop("ip") == "172.18.0.3"  # malformed: keep the socket address
    mw(rf.get("/", HTTP_X_VISITOR_IP="2001:db8::1", **forged))
    assert seen.pop("ip") == "2001:db8::1"


def test_settings_trust_no_header_and_check_the_bot_check_unless_told():
    """The image runs with these settings anywhere; a header is forgeable without a proxy that sets it."""
    import os
    import subprocess
    import sys

    probe = "from django.conf import settings; import django; django.setup(); print(repr(settings.CLIENT_IP_HEADER))"
    base = {k: v for k, v in os.environ.items() if k != "CLIENT_IP_HEADER" and not k.startswith("BOT_CHECK_")}
    base.update(DJANGO_SETTINGS_MODULE="tunnelio.settings.prod", SECRET_KEY="x" * 50)

    def run(extra):
        return subprocess.run([sys.executable, "-c", probe], env={**base, **extra}, capture_output=True, text=True)

    assert run({}).stdout.strip() == "''"
    assert run({"CLIENT_IP_HEADER": "X-Real-IP"}).stdout.strip() == "'X-Real-IP'"
    assert run({"CLIENT_IP_HEADER": "X-Real-IP: 1.2.3.4"}).returncode != 0  # not a header name
    half = {"BOT_CHECK_SECRET_KEY": "s", "BOT_CHECK_SITE_KEY": "k"}
    assert "go together" in run(half).stderr  # keys without the addresses and the script's object
    rest = {
        "BOT_CHECK_SCRIPT_URL": "https://captcha.example/api.js",
        "BOT_CHECK_GLOBAL": "captcha",
        "BOT_CHECK_VERIFY_URL": "https://captcha.example/verify",
    }
    assert run({**half, **rest}).returncode == 0
    assert "https://" in run({**half, **rest, "BOT_CHECK_VERIFY_URL": "http://captcha.example/verify"}).stderr
    assert "BOT_CHECK_GLOBAL" in run({**half, **rest, "BOT_CHECK_GLOBAL": "window.captcha"}).stderr


def test_version_says_which_public_commit_this_is(settings):
    c = Client()
    r = c.get("/api/version")
    assert r.status_code == 200 and r.json() == {"revision": "development"}
    assert "no-cache" in r.headers.get("Cache-Control", "")
    settings.TUNNELIO_REVISION = "0123456789abcdef0123456789abcdef01234567"
    assert c.get("/api/version").json() == {"revision": "0123456789abcdef0123456789abcdef01234567"}
