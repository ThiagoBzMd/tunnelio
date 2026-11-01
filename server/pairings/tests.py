"""REST tests for devices and the synced pairings blob (SPEC §10.2, §11.2)."""

from __future__ import annotations

import base64
import os

import pytest
from django.contrib.auth import get_user_model
from django.test import Client

from devices.models import Device, new_device_token
from pairings.models import PairingsBlob
from relay import presence

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


def test_unauthenticated_is_403():
    c = Client()
    assert c.get("/api/devices/pairings").status_code == 403
    assert c.get("/api/devices/").status_code == 403


def test_devices_rest(client, user):
    _, token_hash = new_device_token()
    device = Device.objects.create(user=user, name="PC", platform="linux", token_hash=token_hash)
    other = User.objects.create_user("b@example.com", "correct horse battery staple")
    _, other_hash = new_device_token()
    Device.objects.create(user=other, name="theirs", token_hash=other_hash)
    items = client.get("/api/devices/").json()
    assert [d["name"] for d in items] == ["PC"] and items[0]["online"] is False
    presence.set_online(str(device.id), "chan")
    assert client.get("/api/devices/").json()[0]["online"] is True
    presence.set_offline(str(device.id))
    r = client.patch(f"/api/devices/{device.id}", {"name": "Desk"}, content_type="application/json")
    assert r.status_code == 200 and r.json()["name"] == "Desk"
    assert client.patch(f"/api/devices/{device.id}", {"name": ""}, content_type="application/json").status_code == 400
    assert client.delete(f"/api/devices/{device.id}").status_code == 204
    assert client.delete(f"/api/devices/{device.id}").status_code == 404
    assert Device.objects.filter(user=other).count() == 1


def test_pairings_blob_lifecycle(client, user):
    body = {"timestamp": "2026-10-09T12:00:00Z", "ciphertext": b64(os.urandom(80))}
    assert client.get("/api/devices/pairings").status_code == 404
    assert client.put("/api/devices/pairings", body, content_type="application/json").status_code == 201
    assert client.put("/api/devices/pairings", body, content_type="application/json").status_code == 200
    got = client.get("/api/devices/pairings").json()
    assert got["ciphertext"] == body["ciphertext"] and "updated_at" in got
    big = {"timestamp": "2026-10-09T12:00:00Z", "ciphertext": b64(os.urandom(70 * 1024))}
    assert client.put("/api/devices/pairings", big, content_type="application/json").status_code == 413
    bad = {"timestamp": "x", "ciphertext": "AA"}
    assert client.put("/api/devices/pairings", bad, content_type="application/json").status_code == 400
    other = Client()
    other.force_login(User.objects.create_user("b@example.com", "correct horse battery staple"))
    assert other.get("/api/devices/pairings").status_code == 404  # per user
    assert client.delete("/api/devices/pairings").status_code == 204
    assert client.get("/api/devices/pairings").status_code == 404
    assert PairingsBlob.objects.count() == 0


def test_admin_never_shows_ciphertext_or_token(client, user):
    user.is_staff = user.is_superuser = True
    user.save()
    _, token_hash = new_device_token()
    device = Device.objects.create(user=user, name="PC", token_hash=token_hash)
    blob = PairingsBlob.objects.create(user=user, timestamp="2026-10-08T00:00:00Z", ciphertext=b"SECRET-CIPHERTEXT", size=17)
    page = client.get(f"/admin/pairings/pairingsblob/{blob.id}/change/").content.decode()
    assert "SECRET-CIPHERTEXT" not in page and "U0VDUkVU" not in page
    page = client.get(f"/admin/devices/device/{device.id}/change/").content.decode()
    assert token_hash not in page
