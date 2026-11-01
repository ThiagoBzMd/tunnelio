"""REST tests for the synced preferences blob (SPEC §10.5): opaque, capped, gone after a reset."""

from __future__ import annotations

import base64
import os

import pytest
from django.contrib.auth import get_user_model
from django.test import Client

from preferences.models import PreferencesBlob

User = get_user_model()
pytestmark = pytest.mark.django_db


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


@pytest.fixture
def user():
    return User.objects.create_user("a@example.com", "correct horse battery staple")


@pytest.fixture
def client(user):
    c = Client()
    c.force_login(user)
    return c


def test_needs_login():
    assert Client().get("/api/auth/preferences").status_code == 403


def test_put_get_delete(client, user):
    assert client.get("/api/auth/preferences").status_code == 404
    blob = os.urandom(200)
    body = {"timestamp": "2026-10-14T20:00:00Z", "ciphertext": b64(blob)}
    assert client.put("/api/auth/preferences", body, content_type="application/json").status_code == 201
    assert client.put("/api/auth/preferences", body, content_type="application/json").status_code == 200
    got = client.get("/api/auth/preferences").json()
    assert got["ciphertext"] == b64(blob) and got["timestamp"].startswith("2026-10-14T20:00:00")
    assert PreferencesBlob.objects.get(user=user).size == 200
    assert client.delete("/api/auth/preferences").status_code == 204
    assert client.get("/api/auth/preferences").status_code == 404


def test_rejects_bad_and_large(client):
    bad = [
        {"timestamp": "yesterday", "ciphertext": b64(os.urandom(40))},
        {"timestamp": "2026-10-14T20:00:00Z", "ciphertext": "!!"},
    ]
    for body in bad:
        assert client.put("/api/auth/preferences", body, content_type="application/json").status_code == 400
    short = {"timestamp": "2026-10-14T20:00:00Z", "ciphertext": b64(os.urandom(10))}
    assert client.put("/api/auth/preferences", short, content_type="application/json").status_code == 400
    big = {"timestamp": "2026-10-14T20:00:00Z", "ciphertext": b64(os.urandom(32 * 1024 + 1))}
    assert client.put("/api/auth/preferences", big, content_type="application/json").status_code == 413
