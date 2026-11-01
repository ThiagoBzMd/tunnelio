"""Active sessions (SPEC §11.2): the list, what is recorded (no IP), signing one or all out."""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.test import Client

from accounts.models import LoginSession
from accounts.sessions import parse_user_agent

User = get_user_model()
pytestmark = pytest.mark.django_db

CHROME_LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
SAFARI_IPHONE = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/26.0 Mobile/15E148 Safari/604.1"
)


def test_parse_user_agent():
    assert parse_user_agent(CHROME_LINUX) == ("Chrome", "Linux", "computer")
    assert parse_user_agent(SAFARI_IPHONE) == ("Safari", "iOS", "phone")
    assert parse_user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36 Edg/140.0") == (
        "Edge",
        "Windows",
        "computer",
    )
    assert parse_user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/141.0") == (
        "Firefox",
        "macOS",
        "computer",
    )
    assert parse_user_agent("Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile Safari/537.36") == (
        "Chrome",
        "Android",
        "phone",
    )
    assert parse_user_agent("Mozilla/5.0 (Linux; Android 15; SM-X910) Chrome/140.0 Safari/537.36") == (
        "Chrome",
        "Android",
        "tablet",
    )
    assert parse_user_agent("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) CriOS/140.0 Mobile Safari/604.1") == (
        "Chrome",
        "iPadOS",
        "tablet",
    )
    assert parse_user_agent("node") == ("", "", "other")


def sign_in(user_agent: str) -> Client:
    c = Client(HTTP_USER_AGENT=user_agent)
    assert (
        c.post(
            "/api/auth/login",
            {"email": "a@example.com", "password": "correct horse battery staple"},
            content_type="application/json",
        ).status_code
        == 200
    )
    return c


@pytest.fixture(autouse=True)
def user():
    cache.clear()
    return User.objects.create_user("a@example.com", "correct horse battery staple")


def test_list_marks_current_and_records_no_ip():
    laptop = sign_in(CHROME_LINUX)
    phone = sign_in(SAFARI_IPHONE)
    rows = laptop.get("/api/auth/sessions").json()
    assert [(r["browser"], r["os"], r["device"], r["current"]) for r in rows] == [
        ("Safari", "iOS", "phone", False),
        ("Chrome", "Linux", "computer", True),
    ]
    assert {"id", "created_at", "last_seen_at"} <= set(rows[0])
    assert not {"session_key", "ip"} & set(rows[0])
    fields = {f.name for f in LoginSession._meta.get_fields()}
    assert not any("ip" in f or "address" in f or "city" in f for f in fields)
    assert phone.get("/api/auth/sessions").json()[0]["current"] is True


def test_sign_out_one_then_all():
    laptop = sign_in(CHROME_LINUX)
    phone = sign_in(SAFARI_IPHONE)
    other = next(r for r in laptop.get("/api/auth/sessions").json() if not r["current"])
    assert laptop.delete(f"/api/auth/sessions/{other['id']}").status_code == 204
    assert phone.get("/api/auth/me").json()["authenticated"] is False
    assert len(laptop.get("/api/auth/sessions").json()) == 1
    assert laptop.delete("/api/auth/sessions/999999").status_code == 404
    tablet = sign_in(SAFARI_IPHONE.replace("iPhone", "iPad"))
    assert laptop.post("/api/auth/sessions/logout-all").status_code == 204
    assert laptop.get("/api/auth/me").json()["authenticated"] is False
    assert tablet.get("/api/auth/me").json()["authenticated"] is False
    assert LoginSession.objects.count() == 0


def test_sign_out_current_and_others_untouched_by_other_accounts():
    User.objects.create_user("b@example.com", "correct horse battery staple")
    mine = sign_in(CHROME_LINUX)
    theirs = Client(HTTP_USER_AGENT=CHROME_LINUX)
    theirs.post(
        "/api/auth/login", {"email": "b@example.com", "password": "correct horse battery staple"}, content_type="application/json"
    )
    their_id = theirs.get("/api/auth/sessions").json()[0]["id"]
    assert mine.delete(f"/api/auth/sessions/{their_id}").status_code == 404
    my_id = mine.get("/api/auth/sessions").json()[0]["id"]
    assert mine.delete(f"/api/auth/sessions/{my_id}").status_code == 204
    assert mine.get("/api/auth/me").json()["authenticated"] is False
    assert theirs.get("/api/auth/me").json()["authenticated"] is True


def test_older_session_gets_a_row_and_password_change_ends_the_others():
    old = Client(HTTP_USER_AGENT=CHROME_LINUX)
    old.force_login(User.objects.get(email="a@example.com"))  # no sign-in signal row yet
    LoginSession.objects.all().delete()
    cache.clear()
    assert len(old.get("/api/auth/sessions").json()) == 1  # created on the first request
    phone = sign_in(SAFARI_IPHONE)
    phone_row = next(row["id"] for row in phone.get("/api/auth/sessions").json() if row["current"])
    r = phone.post(
        "/api/auth/change-password",
        {"current_password": "correct horse battery staple", "new_password": "another long passphrase 42"},
        content_type="application/json",
    )
    assert r.status_code == 204
    assert old.get("/api/auth/me").json()["authenticated"] is False
    rows = phone.get("/api/auth/sessions").json()
    assert len(rows) == 1 and rows[0]["current"] is True
    assert rows[0]["id"] == phone_row  # the same row under the session's new key
    assert Session.objects.count() == 1
