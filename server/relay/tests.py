"""
Relay end-to-end tests through the real ASGI application (SPEC §3, §4.2 routing part).
Payloads are opaque to the relay, so these tests use dummy JSON objects for them.
"""

from __future__ import annotations

import asyncio

import pytest
from asgiref.sync import sync_to_async
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.test import Client

from devices.models import Device, PairingSession, new_device_token
from relay import presence
from relay.models import ConnectionLog
from tunnelio.asgi import application

User = get_user_model()
SUBPROTO = ["tunnelio.v1"]
pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.asyncio]


# ── helpers ──────────────────────────────────────────────────────────────────
@database_sync_to_async
def make_user(email="alice@example.com", password="correct horse battery"):
    return User.objects.create_user(email=email, password=password)


@database_sync_to_async
def session_cookie(user) -> str:
    c = Client()
    c.force_login(user)
    return c.cookies["sessionid"].value


@database_sync_to_async
def make_device(user, name="PC"):
    token, token_hash = new_device_token()
    device = Device.objects.create(user=user, name=name, token_hash=token_hash)
    return device, token


async def client_ws(user, origin=b"http://testserver"):
    sid = await session_cookie(user)
    headers = [(b"cookie", f"sessionid={sid}".encode()), (b"origin", origin)]
    comm = WebsocketCommunicator(application, "/ws/client", headers=headers, subprotocols=SUBPROTO)
    connected, proto = await comm.connect()
    assert connected and proto == "tunnelio.v1"
    return comm


async def device_ws(token: str | None = None, subprotocols=SUBPROTO):
    headers = [(b"authorization", f"Bearer {token}".encode())] if token else []
    comm = WebsocketCommunicator(application, "/ws/device", headers=headers, subprotocols=subprotocols)
    connected, _ = await comm.connect()
    assert connected
    return comm


async def hello_client(comm):
    await comm.send_json_to({"type": "hello", "v": 1, "app": "web", "version": "0.0.0"})
    welcome = await comm.receive_json_from()
    assert welcome["type"] == "welcome" and welcome["v"] == 1
    return welcome


async def hello_device(comm):
    await comm.send_json_to(
        {"type": "hello", "v": 1, "app": "tray", "version": "0.0.0", "platform": "linux", "protocol_versions": [1]}
    )
    welcome = await comm.receive_json_from()
    assert welcome["type"] == "welcome"
    return welcome


async def receive_until(comm, frame_type: str, timeout=2):
    """Skip unrelated frames (e.g. device_status) until the wanted type arrives."""
    for _ in range(20):
        frame = await comm.receive_json_from(timeout=timeout)
        if frame["type"] == frame_type:
            return frame
    raise AssertionError(f"frame {frame_type} not received")


# ── pairing + session flow ───────────────────────────────────────────────────
async def test_first_pairing_binds_device_and_relays_data():
    user = await make_user()
    dev = await device_ws()
    welcome = await hello_device(dev)
    assert welcome["device_id"] is None

    await dev.send_json_to({"type": "pair_start"})
    ready = await dev.receive_json_from()
    assert ready["type"] == "pair_ready" and len(ready["claim"]) == 4

    cli = await client_ws(user)
    w = await hello_client(cli)
    assert w["devices"] == []

    await cli.send_json_to({"type": "pair_join", "claim": ready["claim"].lower()})  # case-insensitive
    joined = await cli.receive_json_from()
    assert joined == {"type": "pair_joined", "claim": ready["claim"]}
    assert (await dev.receive_json_from()) == {"type": "pair_joined"}

    # SPAKE2 messages are opaque to the relay
    await cli.send_json_to({"type": "pair_msg", "claim": ready["claim"], "payload": {"t": "pake1", "pA": "xx"}})
    assert (await dev.receive_json_from()) == {"type": "pair_msg", "payload": {"t": "pake1", "pA": "xx"}}
    await dev.send_json_to({"type": "pair_msg", "payload": {"t": "pake2", "pB": "yy", "cB": "zz"}})
    assert (await cli.receive_json_from()) == {
        "type": "pair_msg",
        "claim": ready["claim"],
        "payload": {"t": "pake2", "pB": "yy", "cB": "zz"},
    }
    await cli.send_json_to({"type": "pair_msg", "claim": ready["claim"], "payload": {"t": "pake3", "cA": "aa"}})
    assert (await dev.receive_json_from())["payload"]["t"] == "pake3"

    await dev.send_json_to({"type": "pair_done", "ok": True, "name": "My PC"})
    paired = await dev.receive_json_from()
    assert paired["type"] == "paired" and paired["device_token"] and paired["device_id"]
    result = await receive_until(cli, "pair_result")
    assert result["ok"] is True and result["device"] == {"device_id": paired["device_id"], "name": "My PC"}

    device = await database_sync_to_async(Device.objects.get)(id=paired["device_id"])
    assert device.user_id == user.id and device.platform == "linux"
    assert presence.is_online(paired["device_id"])
    assert await database_sync_to_async(lambda: PairingSession.objects.get(claim=ready["claim"]).state)() == "done"

    # session open + data both ways
    await cli.send_json_to({"type": "open", "device_id": paired["device_id"]})
    opened = await receive_until(cli, "opened")
    assert opened["device_id"] == paired["device_id"]
    so = await dev.receive_json_from()
    assert so["type"] == "session_open" and so["client_id"] == w["client_id"]

    env = {"v": 1, "device_id": paired["device_id"], "nonce": "AAAA", "ciphertext": "BBBB"}
    await cli.send_json_to({"type": "data", "device_id": paired["device_id"], "payload": env})
    assert (await dev.receive_json_from()) == {
        "type": "data",
        "client_id": w["client_id"],
        "device_id": paired["device_id"],
        "payload": env,
    }
    await dev.send_json_to({"type": "data", "client_id": w["client_id"], "payload": {"v": 1, "hs": "hello_ack"}})
    assert (await cli.receive_json_from()) == {
        "type": "data",
        "device_id": paired["device_id"],
        "payload": {"v": 1, "hs": "hello_ack"},
    }

    # client closes the session
    await cli.send_json_to({"type": "close", "device_id": paired["device_id"]})
    assert (await cli.receive_json_from())["type"] == "closed"
    assert (await dev.receive_json_from()) == {"type": "session_closed", "client_id": w["client_id"], "reason": "client"}

    # device goes away → presence offline broadcast
    await dev.disconnect()
    status = await receive_until(cli, "device_status")
    assert status == {"type": "device_status", "device_id": paired["device_id"], "online": False}
    await cli.disconnect()

    logs = await database_sync_to_async(lambda: list(ConnectionLog.objects.order_by("kind").values_list("kind", "frames_in")))()
    assert [k for k, _ in logs] == ["client", "device"]
    assert all(frames > 0 for _, frames in logs)


async def test_second_browser_pairs_existing_device_without_new_token():
    user = await make_user()
    device, token = await make_device(user)
    dev = await device_ws(token)
    assert (await hello_device(dev))["device_id"] == str(device.id)
    await dev.send_json_to({"type": "pair_start"})
    ready = await dev.receive_json_from()

    cli = await client_ws(user)
    await hello_client(cli)
    await cli.send_json_to({"type": "pair_join", "claim": ready["claim"]})
    joined = await cli.receive_json_from()
    assert joined["device_id"] == str(device.id)
    await dev.receive_json_from()  # pair_joined
    await dev.send_json_to({"type": "pair_done", "ok": True, "name": "ignored"})
    result = await receive_until(cli, "pair_result")
    assert result["ok"] is True and result["device"]["device_id"] == str(device.id)
    assert await dev.receive_nothing(timeout=0.2)  # no `paired` frame for an already-paired device
    await dev.disconnect()
    await cli.disconnect()


async def test_pair_done_failed_and_claim_reuse_rules():
    user = await make_user()
    dev = await device_ws()
    await hello_device(dev)
    await dev.send_json_to({"type": "pair_start"})
    ready = await dev.receive_json_from()
    cli = await client_ws(user)
    await hello_client(cli)
    await cli.send_json_to({"type": "pair_join", "claim": ready["claim"]})
    await cli.receive_json_from()
    await dev.receive_json_from()

    # a second browser cannot join a joined claim
    cli2 = await client_ws(user)
    await hello_client(cli2)
    await cli2.send_json_to({"type": "pair_join", "claim": ready["claim"]})
    err = await cli2.receive_json_from()
    assert err["type"] == "error" and err["code"] == "E_PAIR_BUSY"

    await dev.send_json_to({"type": "pair_done", "ok": False})
    result = await receive_until(cli, "pair_result")
    assert result == {"type": "pair_result", "claim": ready["claim"], "ok": False, "code": "E_PAIR_FAILED"}

    # claim is dead now
    await cli2.send_json_to({"type": "pair_join", "claim": ready["claim"]})
    err = await cli2.receive_json_from()
    assert err["code"] == "E_PAIR_NOT_FOUND"
    assert await database_sync_to_async(lambda: Device.objects.count())() == 0
    for c in (dev, cli, cli2):
        await c.disconnect()


async def test_unknown_claim_and_device_disconnect_mid_pairing():
    user = await make_user()
    cli = await client_ws(user)
    await hello_client(cli)
    await cli.send_json_to({"type": "pair_join", "claim": "ZZZZ"})
    assert (await cli.receive_json_from())["code"] == "E_PAIR_NOT_FOUND"

    dev = await device_ws()
    await hello_device(dev)
    await dev.send_json_to({"type": "pair_start"})
    ready = await dev.receive_json_from()
    await cli.send_json_to({"type": "pair_join", "claim": ready["claim"]})
    await cli.receive_json_from()
    await dev.disconnect()
    result = await receive_until(cli, "pair_result")
    assert result["ok"] is False and result["code"] == "E_PAIR_FAILED"
    await cli.disconnect()


# ── auth, presence, replacement, revocation ──────────────────────────────────
async def test_device_token_auth_and_presence():
    user = await make_user()
    device, token = await make_device(user)
    bad = await device_ws("not-a-token")
    assert (await bad.receive_output())["code"] == 4001
    dev = await device_ws(token)
    welcome = await hello_device(dev)
    assert welcome["device_id"] == str(device.id) and presence.is_online(str(device.id))
    cli = await client_ws(user)
    w = await hello_client(cli)
    assert w["devices"] == [{"device_id": str(device.id), "name": "PC", "online": True}]
    await dev.disconnect()
    assert (await receive_until(cli, "device_status"))["online"] is False
    assert not presence.is_online(str(device.id))
    await cli.disconnect()


async def test_device_goes_online_only_after_its_welcome():
    # A browser opens a session the moment a computer shows up. If presence came before the
    # welcome, that session_open would reach the tray first and the tray would drop the
    # connection, over and over.
    user = await make_user()
    device, token = await make_device(user)
    cli = await client_ws(user)
    await hello_client(cli)
    dev = await device_ws(token)
    assert not presence.is_online(str(device.id))
    await cli.send_json_to({"type": "open", "device_id": str(device.id)})
    assert (await receive_until(cli, "error"))["code"] == "E_DEVICE_OFFLINE"
    assert await dev.receive_nothing(timeout=0.2)
    welcome = await hello_device(dev)  # the first frame the tray gets is its welcome
    assert welcome["device_id"] == str(device.id)
    assert (await receive_until(cli, "device_status"))["online"] is True
    await cli.send_json_to({"type": "open", "device_id": str(device.id)})
    assert (await dev.receive_json_from())["type"] == "session_open"
    await dev.disconnect()
    await cli.disconnect()


async def test_second_device_connection_replaces_first():
    user = await make_user()
    device, token = await make_device(user)
    first = await device_ws(token)
    await hello_device(first)
    second = await device_ws(token)
    await hello_device(second)
    closed = await first.receive_output()
    assert closed["type"] == "websocket.close" and closed["code"] == 4006
    assert presence.get_channel(str(device.id)) is not None
    await second.disconnect()
    assert not presence.is_online(str(device.id))


async def test_rest_delete_revokes_live_device():
    user = await make_user()
    device, token = await make_device(user)
    dev = await device_ws(token)
    await hello_device(dev)
    cli = await client_ws(user)
    await hello_client(cli)

    def rest_delete():
        c = Client()
        c.force_login(user)
        return c.delete(f"/api/devices/{device.id}").status_code

    assert await sync_to_async(rest_delete)() == 204
    assert (await dev.receive_json_from())["type"] == "revoked"
    assert (await dev.receive_output())["code"] == 4001
    assert (await receive_until(cli, "device_status"))["online"] is False
    assert await database_sync_to_async(lambda: Device.objects.filter(id=device.id).exists())() is False
    # reconnecting with the old token is refused
    again = await device_ws(token)
    assert (await again.receive_output())["code"] == 4001
    await cli.disconnect()
    # The closed device connection is still logged, without the deleted device (no FK error).
    await dev.disconnect()

    def device_logs():
        return list(ConnectionLog.objects.filter(kind=ConnectionLog.DEVICE).values_list("device_id", "close_code"))

    for _ in range(50):
        if logs := await database_sync_to_async(device_logs)():
            break
        await asyncio.sleep(0.02)
    assert logs and logs[0][0] is None and logs[0][1] == 4001


# ── protocol hygiene ─────────────────────────────────────────────────────────
async def test_client_requires_login_and_origin():
    user = await make_user()
    comm = WebsocketCommunicator(application, "/ws/client", headers=[(b"origin", b"http://testserver")], subprotocols=SUBPROTO)
    connected, _ = await comm.connect()
    assert connected and (await comm.receive_output())["code"] == 4001
    sid = await session_cookie(user)
    comm = WebsocketCommunicator(
        application,
        "/ws/client",
        headers=[(b"cookie", f"sessionid={sid}".encode()), (b"origin", b"http://evil.example")],
        subprotocols=SUBPROTO,
    )
    connected, _ = await comm.connect()
    assert connected is False


async def test_client_origin_is_the_servers_own_address_or_a_trusted_one():
    """Self-hosting needs only ALLOWED_HOSTS: the relay accepts the server's own address."""
    from django.test import override_settings

    from relay.origin import same_origin

    user = await make_user()
    sid = await session_cookie(user)

    async def connects(origin: bytes, host: bytes | None = None, forwarded: bytes | None = None) -> bool:
        headers = [(b"cookie", f"sessionid={sid}".encode()), (b"origin", origin)]
        if host:
            headers.append((b"host", host))
        if forwarded:
            headers.append((b"x-forwarded-host", forwarded))
        comm = WebsocketCommunicator(application, "/ws/client", headers=headers, subprotocols=SUBPROTO)
        connected, _ = await comm.connect()
        if connected:
            await comm.disconnect()
        return connected

    with override_settings(ALLOWED_HOSTS=["testserver", "tunnelio.example.ts.net", "localhost"]):
        assert await connects(b"https://tunnelio.example.ts.net", b"tunnelio.example.ts.net")  # behind a TLS proxy
        assert await connects(b"https://tunnelio.example.ts.net", b"127.0.0.1:8080", b"tunnelio.example.ts.net")
        assert await connects(b"http://localhost:8097", b"localhost:8097")
        assert not await connects(b"http://localhost:8097", b"localhost:8080")  # another port is another origin
        assert not await connects(b"https://evil.example", b"tunnelio.example.ts.net")  # another site
        assert not await connects(b"https://other.example", b"other.example")  # a name the server does not serve
        assert await connects(b"http://testserver")  # CSRF_TRUSTED_ORIGINS still count
    assert not same_origin([(b"host", b"tunnelio.example.ts.net")])  # no Origin at all
    assert not same_origin([(b"origin", b"null"), (b"host", b"null")])


async def test_wrong_subprotocol_is_denied():
    comm = WebsocketCommunicator(application, "/ws/device", subprotocols=["other"])
    connected, _ = await comm.connect()
    assert connected is False


async def test_hello_must_come_first_and_unknown_type_closes():
    dev = await device_ws()
    await dev.send_json_to({"type": "ping"})
    assert (await dev.receive_output())["code"] == 4002
    dev = await device_ws()
    await hello_device(dev)
    await dev.send_json_to({"type": "exec", "cmd": "rm -rf /"})
    assert (await dev.receive_json_from())["code"] == "E_INVALID"
    assert (await dev.receive_output())["code"] == 4002
    dev = await device_ws()
    await dev.send_to(text_data="not json")
    assert (await dev.receive_output())["code"] == 4002


async def test_oversize_frame_closes_4004(settings):
    settings.RELAY_MAX_FRAME_BYTES = 200
    dev = await device_ws()
    await hello_device(dev)
    await dev.send_json_to({"type": "ping", "t": "x" * 300})
    assert (await dev.receive_output())["code"] == 4004


async def test_device_welcome_announces_the_latest_tray_when_configured(settings):
    dev = await device_ws()
    assert "latest" not in await hello_device(dev)
    await dev.disconnect()
    settings.TRAY_LATEST_VERSION = "0.2.0"
    settings.TRAY_DOWNLOAD_URL = "https://example.com/#download"
    dev = await device_ws()
    assert (await hello_device(dev))["latest"] == {"version": "0.2.0", "url": "https://example.com/#download"}
    await dev.disconnect()
    settings.TRAY_DOWNLOAD_URL = "http://example.com/"  # not https: nothing is announced
    dev = await device_ws()
    assert "latest" not in await hello_device(dev)
    await dev.disconnect()


async def test_open_requires_online_owned_device():
    user = await make_user()
    other = await make_user("bob@example.com")
    mine, _ = await make_device(user, "mine")
    theirs, theirs_token = await make_device(other, "theirs")
    cli = await client_ws(user)
    await hello_client(cli)
    await cli.send_json_to({"type": "open", "device_id": str(mine.id)})
    assert (await cli.receive_json_from())["code"] == "E_DEVICE_OFFLINE"
    dev = await device_ws(theirs_token)
    await hello_device(dev)
    await cli.send_json_to({"type": "open", "device_id": str(theirs.id)})
    assert (await cli.receive_json_from())["code"] == "E_NOT_FOUND"
    await cli.send_json_to({"type": "data", "device_id": str(mine.id), "payload": {}})
    assert (await cli.receive_json_from())["code"] == "E_NO_SESSION"
    await cli.send_json_to({"type": "open", "device_id": "nope"})
    assert (await cli.receive_json_from())["code"] == "E_INVALID"
    await dev.disconnect()
    await cli.disconnect()


async def test_rate_limit_emits_error_then_recovers():
    dev = await device_ws()
    await hello_device(dev)
    burst = dev.application  # noqa: F841 (document intent: burst = 3× RELAY_DEVICE_FPS)
    errors = 0
    for _ in range(300):
        await dev.send_json_to({"type": "ping", "t": 1})
    for _ in range(300):
        frame = await dev.receive_json_from()
        if frame["type"] == "error":
            assert frame["code"] == "E_RATE_LIMIT" and frame["retry_after_ms"] > 0
            errors += 1
    assert errors > 0
    await asyncio.sleep(0.2)
    await dev.send_json_to({"type": "ping", "t": 2})
    assert (await dev.receive_json_from()) == {"type": "pong", "t": 2}
    await dev.disconnect()


async def test_ping_pong_and_version_check():
    dev = await device_ws()
    await dev.send_json_to(
        {"type": "hello", "v": 2, "app": "tray", "version": "x", "platform": "linux", "protocol_versions": [2]}
    )
    assert (await dev.receive_json_from())["code"] == "E_VERSION"
    dev = await device_ws()
    await hello_device(dev)
    await dev.send_json_to({"type": "ping", "t": 123})
    assert (await dev.receive_json_from()) == {"type": "pong", "t": 123}
    await dev.disconnect()


async def test_device_can_close_a_session():
    user = await make_user()
    device, token = await make_device(user)
    dev = await device_ws(token)
    await hello_device(dev)
    cli = await client_ws(user)
    w = await hello_client(cli)
    await cli.send_json_to({"type": "open", "device_id": str(device.id)})
    await receive_until(cli, "opened")
    so = await dev.receive_json_from()
    assert so["type"] == "session_open"
    await dev.send_json_to({"type": "close", "client_id": w["client_id"]})
    assert (await dev.receive_json_from()) == {"type": "session_closed", "client_id": w["client_id"], "reason": "device"}
    assert (await cli.receive_json_from()) == {"type": "closed", "device_id": str(device.id), "reason": "device"}
    # the session is gone on both sides
    await cli.send_json_to({"type": "data", "device_id": str(device.id), "payload": {}})
    assert (await cli.receive_json_from())["code"] == "E_NO_SESSION"
    await dev.send_json_to({"type": "data", "client_id": w["client_id"], "payload": {}})
    assert (await dev.receive_json_from())["code"] == "E_NO_SESSION"
    await dev.disconnect()
    await cli.disconnect()


async def test_other_account_cannot_pair_an_owned_device_even_with_the_code():
    owner = await make_user()
    intruder = await make_user("mallory@example.com")
    device, token = await make_device(owner)
    dev = await device_ws(token)
    await hello_device(dev)
    await dev.send_json_to({"type": "pair_start"})
    ready = await dev.receive_json_from()

    # the intruder knows the claim (shoulder-surfed the code) but is logged into another account
    cli = await client_ws(intruder)
    await hello_client(cli)
    await cli.send_json_to({"type": "pair_join", "claim": ready["claim"]})
    err = await cli.receive_json_from()
    assert err["type"] == "error" and err["code"] == "E_PAIR_NOT_FOUND"
    assert await dev.receive_nothing(timeout=0.2)  # the device never learns anyone tried

    # the owner can still use the same code afterwards
    me = await client_ws(owner)
    await hello_client(me)
    await me.send_json_to({"type": "pair_join", "claim": ready["claim"]})
    assert (await me.receive_json_from())["type"] == "pair_joined"
    assert (await dev.receive_json_from()) == {"type": "pair_joined"}
    for c in (dev, cli, me):
        await c.disconnect()


async def test_a_session_whose_key_changes_keeps_its_socket_until_signed_out():
    from django.utils import timezone

    from accounts.models import LoginSession
    from accounts.sessions import rekey, revoke

    user = await make_user()
    sid = await session_cookie(user)
    await database_sync_to_async(LoginSession.objects.update_or_create)(
        session_key=sid, defaults={"user": user, "last_seen_at": timezone.now()}
    )
    headers = [(b"cookie", f"sessionid={sid}".encode()), (b"origin", b"http://testserver")]
    comm = WebsocketCommunicator(application, "/ws/client", headers=headers, subprotocols=SUBPROTO)
    connected, _ = await comm.connect()
    assert connected
    new_key = "k" * 32
    await database_sync_to_async(rekey)(sid, new_key)  # password change: same browser, new key
    await database_sync_to_async(revoke)([sid])  # ending "the others" never reaches this socket
    while not await comm.receive_nothing(timeout=0.3):
        assert (await comm.receive_output())["type"] != "websocket.close"
    await database_sync_to_async(revoke)([new_key])  # signed out under the new key: closed
    closed = None
    for _ in range(5):
        out = await comm.receive_output(timeout=2)
        if out["type"] == "websocket.close":
            closed = out
            break
    assert closed is not None and closed["code"] == 4001


async def test_signing_a_session_out_closes_its_live_socket():
    from accounts.sessions import revoke

    user = await make_user()
    sid = await session_cookie(user)
    headers = [(b"cookie", f"sessionid={sid}".encode()), (b"origin", b"http://testserver")]
    comm = WebsocketCommunicator(application, "/ws/client", headers=headers, subprotocols=SUBPROTO)
    connected, _ = await comm.connect()
    assert connected
    other = await client_ws(user)  # another browser of the same account stays connected
    await database_sync_to_async(revoke)([sid])
    closed = None
    for _ in range(5):
        out = await comm.receive_output(timeout=2)
        if out["type"] == "websocket.close":
            closed = out
            break
    assert closed is not None and closed["code"] == 4001
    # The other browser's socket is untouched: nothing but (at most) its welcome frame.
    while not await other.receive_nothing(timeout=0.3):
        assert (await other.receive_output())["type"] != "websocket.close"
    await other.disconnect()
