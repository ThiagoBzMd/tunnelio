"""
Blind relay consumers (SPEC §3). The relay reads ONLY routing metadata — `type`, `device_id`,
`client_id`, `claim` — and frame sizes. `payload` objects are forwarded untouched and never
logged.

Channel-layer event types (internal):
    relay.session_open / relay.session_closed / relay.data / relay.pair_joined /
    relay.pair_msg / relay.pair_result / relay.pair_aborted / relay.revoked / relay.replaced /
    device.status (group user.<id>)
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
import uuid

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

from accounts.sessions import socket_group
from devices.models import Device, PairingSession
from devices.services import DeviceLimitReached, authenticate_device, pairing_bind, touch_device

from . import presence
from .models import ConnectionLog
from .ratelimit import TokenBucket, window_allow

log = logging.getLogger("relay")

SUBPROTOCOL = "tunnelio.v1"
PROTOCOL_VERSION = 1

# Close codes (SPEC §3.5)
CLOSE_UNAUTHORIZED = 4001
CLOSE_PROTOCOL = 4002
CLOSE_RATE_LIMIT = 4003
CLOSE_TOO_LARGE = 4004
CLOSE_SHUTDOWN = 4005
CLOSE_REPLACED = 4006


def user_group(user_id) -> str:
    return f"user.{user_id}"


def _is_uuid(value) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, TypeError, AttributeError):
        return False


def latest_tray() -> dict | None:
    """The newest computer-app release for the device welcome (SPEC §3.4), when configured."""
    version, url = settings.TRAY_LATEST_VERSION, settings.TRAY_DOWNLOAD_URL
    if not version or not url.startswith("https://"):
        return None
    return {"version": version[:32], "url": url[:300]}


class BaseRelayConsumer(AsyncJsonWebsocketConsumer):
    """Shared plumbing: subprotocol, size/rate limits, idle timeout, metadata logging."""

    kind = ""
    frames_per_second = 20
    burst = 60

    async def connect(self):
        self.connected_at = timezone.now()
        self.last_frame = time.monotonic()
        self.frames_in = self.frames_out = self.bytes_in = self.bytes_out = 0
        self.user_id = None
        self.device_id: str | None = None
        self.hello_done = False
        self.closing_code: int | None = None
        self.frame_bucket = TokenBucket(self.frames_per_second, self.burst)
        self.byte_bucket = TokenBucket(settings.RELAY_BYTES_PER_MIN / 60.0, settings.RELAY_BYTES_PER_MIN)
        self.rate_strike_since: float | None = None
        self.limits = {"max_frame_bytes": settings.RELAY_MAX_FRAME_BYTES}
        if SUBPROTOCOL not in (self.scope.get("subprotocols") or []):
            await self.close()  # deny the handshake: wrong/missing subprotocol
            return False
        await self.accept(subprotocol=SUBPROTOCOL)
        self._idle_task = asyncio.create_task(self._idle_watchdog())
        return True

    async def _idle_watchdog(self):
        timeout = settings.RELAY_IDLE_TIMEOUT_SECONDS
        try:
            while True:
                await asyncio.sleep(5)
                if time.monotonic() - self.last_frame > timeout:
                    await self.close_with(CLOSE_PROTOCOL)
                    return
        except asyncio.CancelledError:
            return

    async def close_with(self, code: int):
        self.closing_code = code
        await self.close(code=code)

    # ── frames in ────────────────────────────────────────────────────────────
    async def receive(self, text_data=None, bytes_data=None):
        if text_data is None:
            await self.close_with(CLOSE_PROTOCOL)  # binary frames are reserved
            return
        size = len(text_data)
        if size > settings.RELAY_MAX_FRAME_BYTES:
            await self.close_with(CLOSE_TOO_LARGE)
            return
        self.frames_in += 1
        self.bytes_in += size
        self.last_frame = time.monotonic()
        if not (self.frame_bucket.allow() and self.byte_bucket.allow(size)):
            now = time.monotonic()
            self.rate_strike_since = self.rate_strike_since or now
            if now - self.rate_strike_since > 10:
                await self.close_with(CLOSE_RATE_LIMIT)
                return
            await self.send_error("E_RATE_LIMIT", retry_after_ms=self.frame_bucket.retry_after_ms())
            return
        self.rate_strike_since = None
        try:
            content = json.loads(text_data)
        except ValueError:
            await self.close_with(CLOSE_PROTOCOL)
            return
        if not isinstance(content, dict) or not isinstance(content.get("type"), str):
            await self.close_with(CLOSE_PROTOCOL)
            return
        frame_type = content["type"]
        if not self.hello_done and frame_type != "hello":
            await self.close_with(CLOSE_PROTOCOL)
            return
        handler = getattr(self, f"on_{frame_type}", None)
        if handler is None:
            await self.send_error("E_INVALID", message=f"unknown frame type {frame_type!r}")
            await self.close_with(CLOSE_PROTOCOL)
            return
        await handler(content)

    # ── frames out ───────────────────────────────────────────────────────────
    async def send_json(self, content, close=False):
        text = json.dumps(content, separators=(",", ":"), default=str)
        self.frames_out += 1
        self.bytes_out += len(text)
        await super().send(text_data=text, close=close)

    async def send_error(self, code: str, message: str | None = None, ref=None, retry_after_ms: int | None = None):
        frame = {"type": "error", "code": code}
        if message:
            frame["message"] = message
        if ref is not None:
            frame["ref"] = ref
        if retry_after_ms is not None:
            frame["retry_after_ms"] = retry_after_ms
        await self.send_json(frame)

    async def on_ping(self, content):
        await self.send_json({"type": "pong", "t": content.get("t")})

    # ── teardown ─────────────────────────────────────────────────────────────
    async def disconnect(self, code):
        task = getattr(self, "_idle_task", None)
        if task:
            task.cancel()
        await self._log_connection(code)

    async def _log_connection(self, code):
        if self.user_id is None:
            return
        close_code = self.closing_code or (code if isinstance(code, int) else None)

        def write() -> None:
            from django.contrib.auth import get_user_model

            from devices.models import Device

            # The account or the device may be gone already (account deletion, device removed,
            # password changed): keep the log without the dangling reference, or skip it.
            if not get_user_model().objects.filter(pk=self.user_id).exists():
                return
            device_id = self.device_id if self.device_id and Device.objects.filter(pk=self.device_id).exists() else None
            ConnectionLog.objects.create(
                user_id=self.user_id,
                device_id=device_id,
                kind=self.kind,
                connected_at=self.connected_at,
                disconnected_at=timezone.now(),
                bytes_in=self.bytes_in,
                bytes_out=self.bytes_out,
                frames_in=self.frames_in,
                frames_out=self.frames_out,
                close_code=close_code,
            )

        try:
            await database_sync_to_async(write)()
        except Exception:  # logging must never break teardown
            log.exception("could not write ConnectionLog")


# ═════════════════════════════════════════════════════════════════════════════
# /ws/client — browser side (SPEC §3.3)
# ═════════════════════════════════════════════════════════════════════════════
class ClientConsumer(BaseRelayConsumer):
    kind = ConnectionLog.CLIENT
    frames_per_second = settings.RELAY_CLIENT_FPS
    burst = settings.RELAY_CLIENT_FPS * 3

    async def connect(self):
        if not await super().connect():
            return
        user = self.scope.get("user")
        if user is None or not user.is_authenticated:
            await self.close_with(CLOSE_UNAUTHORIZED)
            return
        self.user_id = user.id
        self.client_id = secrets.token_hex(8)
        self.sessions: dict[str, str] = {}  # device_id → device channel
        self.pairings: dict[str, str] = {}  # claim → device channel
        count_key = f"clients:user:{self.user_id}"
        try:
            count = cache.incr(count_key)
        except ValueError:
            cache.add(count_key, 1, 3600)
            count = 1
        self._counted = True
        if count > settings.RELAY_MAX_CLIENTS_PER_USER:
            await self.send_error("E_LIMIT", message="too many connections")
            await self.close_with(CLOSE_RATE_LIMIT)
            return
        await self.channel_layer.group_add(user_group(self.user_id), self.channel_name)
        # Closed at once when this browser's login session ends (accounts.sessions.revoke).
        session_key = getattr(self.scope.get("session"), "session_key", None)
        self.login_group = await database_sync_to_async(socket_group)(session_key) if session_key else None
        if self.login_group:
            await self.channel_layer.group_add(self.login_group, self.channel_name)

    async def session_revoked(self, event):
        await self.close_with(CLOSE_UNAUTHORIZED)

    async def disconnect(self, code):
        if getattr(self, "login_group", None):
            await self.channel_layer.group_discard(self.login_group, self.channel_name)
        if getattr(self, "_counted", False):
            try:
                cache.decr(f"clients:user:{self.user_id}")
            except ValueError:
                pass
        if self.user_id is not None:
            await self.channel_layer.group_discard(user_group(self.user_id), self.channel_name)
            for device_channel in list(getattr(self, "sessions", {}).values()):
                await self.channel_layer.send(
                    device_channel, {"type": "relay.session_closed", "client_id": self.client_id, "reason": "client"}
                )
        await super().disconnect(code)

    # ── inbound frames ───────────────────────────────────────────────────────
    async def on_hello(self, content):
        if content.get("v") != PROTOCOL_VERSION:
            await self.send_error("E_VERSION")
            await self.close_with(CLOSE_PROTOCOL)
            return
        self.hello_done = True
        devices = await self._device_list()
        await self.send_json(
            {"type": "welcome", "v": PROTOCOL_VERSION, "client_id": self.client_id, "devices": devices, "limits": self.limits}
        )

    @database_sync_to_async
    def _device_list(self):
        devices = list(Device.objects.filter(user_id=self.user_id).values("id", "name"))
        online = presence.online_set([str(d["id"]) for d in devices])
        return [{"device_id": str(d["id"]), "name": d["name"], "online": str(d["id"]) in online} for d in devices]

    @database_sync_to_async
    def _owns_device(self, device_id: str) -> bool:
        return Device.objects.filter(id=device_id, user_id=self.user_id).exists()

    async def on_open(self, content):
        device_id = content.get("device_id")
        if not _is_uuid(device_id):
            await self.send_error("E_INVALID", message="device_id must be a UUID")
            return
        device_id = str(uuid.UUID(str(device_id)))
        if device_id in self.sessions:
            await self.send_json({"type": "opened", "device_id": device_id})
            return
        if not await self._owns_device(device_id):
            await self.send_error("E_NOT_FOUND", ref=device_id)
            return
        if len(self.sessions) >= settings.RELAY_MAX_SESSIONS_PER_CLIENT:
            await self.send_error("E_LIMIT", message="too many open sessions", ref=device_id)
            return
        device_channel = presence.get_channel(device_id)
        if device_channel is None:
            await self.send_error("E_DEVICE_OFFLINE", ref=device_id)
            return
        self.sessions[device_id] = device_channel
        await self.channel_layer.send(
            device_channel,
            {"type": "relay.session_open", "client_id": self.client_id, "client_channel": self.channel_name},
        )
        await self.send_json({"type": "opened", "device_id": device_id})

    async def on_close(self, content):
        device_id = str(content.get("device_id", ""))
        device_channel = self.sessions.pop(device_id, None)
        if device_channel is not None:
            await self.channel_layer.send(
                device_channel, {"type": "relay.session_closed", "client_id": self.client_id, "reason": "client"}
            )
        await self.send_json({"type": "closed", "device_id": device_id, "reason": "client"})

    async def on_data(self, content):
        device_id = str(content.get("device_id", ""))
        device_channel = self.sessions.get(device_id)
        if device_channel is None:
            await self.send_error("E_NO_SESSION", ref=device_id)
            return
        payload = content.get("payload")
        if not isinstance(payload, dict):
            await self.send_error("E_INVALID", message="payload must be an object", ref=device_id)
            return
        await self.channel_layer.send(
            device_channel,
            {"type": "relay.data", "client_id": self.client_id, "device_id": device_id, "payload": payload},
        )

    async def on_pair_join(self, content):
        claim = str(content.get("claim", "")).upper()
        if len(claim) != 4:
            await self.send_error("E_INVALID", message="claim must have 4 symbols")
            return
        if not window_allow(f"pair_join:user:{self.user_id}", settings.PAIR_JOIN_RATE):
            await self.send_error("E_RATE_LIMIT", ref=claim)
            return
        result = await self._join_pairing(claim)
        if result is None:
            await self.send_error("E_PAIR_NOT_FOUND", ref=claim)
            return
        if result == "busy":
            await self.send_error("E_PAIR_BUSY", ref=claim)
            return
        device_channel, device_id = result
        self.pairings[claim] = device_channel
        await self.channel_layer.send(
            device_channel, {"type": "relay.pair_joined", "claim": claim, "client_channel": self.channel_name}
        )
        frame = {"type": "pair_joined", "claim": claim}
        if device_id:
            frame["device_id"] = device_id
        await self.send_json(frame)

    @database_sync_to_async
    def _join_pairing(self, claim: str):
        session = PairingSession.find_active(claim)
        if session is None:
            return None
        # A device already bound to an account can only be paired by that account (SPEC §4.2 rule 4:
        # pairing is approved by the signed-in user; device sharing between accounts is out of scope).
        # Answer exactly like an unknown claim so other accounts cannot probe for live codes.
        if session.device_id is not None and session.device.user_id != self.user_id:
            return None
        if session.state != PairingSession.WAITING:
            return "busy"
        session.user_id = self.user_id
        session.client_channel = self.channel_name
        session.state = PairingSession.JOINED
        session.save(update_fields=["user", "client_channel", "state"])
        return session.device_channel, (str(session.device_id) if session.device_id else None)

    async def on_pair_msg(self, content):
        claim = str(content.get("claim", "")).upper()
        device_channel = self.pairings.get(claim)
        payload = content.get("payload")
        if device_channel is None:
            await self.send_error("E_PAIR_NOT_FOUND", ref=claim)
            return
        if not isinstance(payload, dict):
            await self.send_error("E_INVALID", message="payload must be an object", ref=claim)
            return
        await self.channel_layer.send(device_channel, {"type": "relay.pair_msg", "payload": payload})

    # ── channel-layer events ─────────────────────────────────────────────────
    async def relay_data(self, event):
        await self.send_json({"type": "data", "device_id": event["device_id"], "payload": event["payload"]})

    async def relay_session_closed(self, event):
        device_id = event["device_id"]
        if self.sessions.pop(device_id, None) is not None:
            await self.send_json({"type": "closed", "device_id": device_id, "reason": event.get("reason", "device")})

    async def relay_pair_msg(self, event):
        await self.send_json({"type": "pair_msg", "claim": event["claim"], "payload": event["payload"]})

    async def relay_pair_result(self, event):
        claim = event["claim"]
        self.pairings.pop(claim, None)
        frame = {"type": "pair_result", "claim": claim, "ok": bool(event.get("ok"))}
        if event.get("device"):
            frame["device"] = event["device"]
        if event.get("code"):
            frame["code"] = event["code"]
        await self.send_json(frame)

    async def device_status(self, event):
        device_id = event["device_id"]
        online = bool(event["online"])
        await self.send_json({"type": "device_status", "device_id": device_id, "online": online})
        if not online and self.sessions.pop(device_id, None) is not None:
            await self.send_json({"type": "closed", "device_id": device_id, "reason": "device_offline"})


# ═════════════════════════════════════════════════════════════════════════════
# /ws/device — tray side (SPEC §3.4)
# ═════════════════════════════════════════════════════════════════════════════
class DeviceConsumer(BaseRelayConsumer):
    kind = ConnectionLog.DEVICE
    frames_per_second = settings.RELAY_DEVICE_FPS
    burst = settings.RELAY_DEVICE_FPS * 3

    async def connect(self):
        if not await super().connect():
            return
        headers = dict(self.scope.get("headers") or [])
        auth = headers.get(b"authorization", b"").decode("latin1")
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else None
        self.sessions: dict[str, str] = {}  # client_id → client channel
        self.pairing_id: int | None = None
        self.pair_claim: str | None = None
        self.pair_client_channel: str | None = None
        self.pair_bucket = TokenBucket(3 / 60.0, 3)
        self.replaced = False
        self.online = False
        self.platform = ""
        self.tray_version = ""
        if token:
            device = await database_sync_to_async(authenticate_device)(token)
            if device is None:
                await self.close_with(CLOSE_UNAUTHORIZED)
                return
            self.device_id = str(device.id)
            self.user_id = device.user_id
            # Online only after the welcome (on_hello): browsers open a session the moment a
            # computer shows up, and a session_open that beats the welcome makes the tray drop the
            # connection (it expects the welcome first), over and over.
        # no token: unpaired mode — only hello / pair_* / ping are useful

    async def _go_online(self):
        self.online = True
        old = presence.get_channel(self.device_id)
        if old and old != self.channel_name:
            await self.channel_layer.send(old, {"type": "relay.replaced"})
        presence.set_online(self.device_id, self.channel_name)
        await self.channel_layer.group_send(
            user_group(self.user_id), {"type": "device.status", "device_id": self.device_id, "online": True}
        )

    async def disconnect(self, code):
        if self.device_id and not self.replaced and presence.set_offline(self.device_id, self.channel_name):
            await self.channel_layer.group_send(
                user_group(self.user_id), {"type": "device.status", "device_id": self.device_id, "online": False}
            )
        for client_channel in list(getattr(self, "sessions", {}).values()):
            await self.channel_layer.send(
                client_channel, {"type": "relay.session_closed", "device_id": self.device_id, "reason": "device_offline"}
            )
        if getattr(self, "pairing_id", None) is not None:
            await self._fail_pairing("E_PAIR_FAILED")
        await super().disconnect(code)

    # ── inbound frames ───────────────────────────────────────────────────────
    async def on_hello(self, content):
        if content.get("v") != PROTOCOL_VERSION or PROTOCOL_VERSION not in (content.get("protocol_versions") or [1]):
            await self.send_error("E_VERSION")
            await self.close_with(CLOSE_PROTOCOL)
            return
        self.hello_done = True
        self.platform = str(content.get("platform", ""))[:16]
        self.tray_version = str(content.get("version", ""))[:32]
        if self.device_id:
            await database_sync_to_async(touch_device)(self.device_id, platform=self.platform, tray_version=self.tray_version)
        welcome = {"type": "welcome", "v": PROTOCOL_VERSION, "device_id": self.device_id, "limits": self.limits}
        latest = latest_tray()
        if latest:
            welcome["latest"] = latest
        await self.send_json(welcome)
        if self.device_id and not self.online:
            await self._go_online()

    async def on_ping(self, content):
        if self.device_id and self.online and not self.replaced:
            presence.refresh(self.device_id, self.channel_name)
        await super().on_ping(content)

    async def on_pair_start(self, content):
        if not self.pair_bucket.allow():
            await self.send_error("E_RATE_LIMIT", retry_after_ms=self.pair_bucket.retry_after_ms())
            return
        if self.pairing_id is not None:
            await self._expire_pairing()
        session = await database_sync_to_async(self._start_pairing)()
        self.pairing_id = session.id
        self.pair_claim = session.claim
        self.pair_client_channel = None
        await self.send_json({"type": "pair_ready", "claim": session.claim, "expires_at": session.expires_at})

    def _start_pairing(self):
        device = Device.objects.filter(id=self.device_id).first() if self.device_id else None
        return PairingSession.start(self.channel_name, device)

    async def on_pair_msg(self, content):
        payload = content.get("payload")
        if self.pairing_id is None or self.pair_client_channel is None:
            await self.send_error("E_PAIR_NOT_FOUND")
            return
        if not isinstance(payload, dict):
            await self.send_error("E_INVALID", message="payload must be an object")
            return
        await self.channel_layer.send(
            self.pair_client_channel, {"type": "relay.pair_msg", "claim": self.pair_claim, "payload": payload}
        )

    async def on_pair_done(self, content):
        if self.pairing_id is None:
            await self.send_error("E_PAIR_NOT_FOUND")
            return
        if not content.get("ok"):
            await self._fail_pairing("E_PAIR_FAILED")
            return
        name = str(content.get("name", ""))[:64] or "Device"
        try:
            device_id, user_id, token, device_name = await database_sync_to_async(self._bind)(name)
        except DeviceLimitReached:
            await self._fail_pairing("E_LIMIT")
            await self.send_json({"type": "pair_aborted", "reason": "device_limit"})
            return
        except ValueError:
            await self._fail_pairing("E_PAIR_FAILED")
            return
        client_channel, claim = self.pair_client_channel, self.pair_claim
        self.pairing_id = self.pair_claim = self.pair_client_channel = None
        if token:  # first pairing: this connection becomes the device's live connection
            self.device_id, self.user_id = device_id, user_id
            await self._go_online()
            await self.send_json({"type": "paired", "device_id": device_id, "device_token": token})
        if client_channel:
            await self.channel_layer.send(
                client_channel,
                {
                    "type": "relay.pair_result",
                    "claim": claim,
                    "ok": True,
                    "device": {"device_id": device_id, "name": device_name},
                },
            )

    def _bind(self, name: str):
        session = PairingSession.objects.select_related("device", "user").get(id=self.pairing_id)
        if session.state != PairingSession.JOINED or session.is_expired:
            raise ValueError("pairing not joined or expired")
        device, token = pairing_bind(session, name, platform=self.platform, tray_version=self.tray_version)
        return str(device.id), device.user_id, token, device.name

    async def _fail_pairing(self, code: str):
        client_channel, claim, pairing_id = self.pair_client_channel, self.pair_claim, self.pairing_id
        if client_channel is None and pairing_id is not None:  # device never saw relay.pair_joined
            client_channel = await database_sync_to_async(
                lambda: PairingSession.objects.filter(id=pairing_id).values_list("client_channel", flat=True).first()
            )()
        await self._expire_pairing(PairingSession.FAILED)
        if client_channel:
            await self.channel_layer.send(
                client_channel, {"type": "relay.pair_result", "claim": claim, "ok": False, "code": code}
            )

    async def _expire_pairing(self, state: str = PairingSession.EXPIRED):
        pairing_id, self.pairing_id = self.pairing_id, None
        self.pair_claim = self.pair_client_channel = None
        if pairing_id is not None:
            await database_sync_to_async(
                lambda: PairingSession.objects.filter(id=pairing_id, state__in=PairingSession.ACTIVE).update(state=state)
            )()

    async def on_close(self, content):
        """Device-initiated session close (e.g. envelope counter violation, SPEC §6.3)."""
        client_id = str(content.get("client_id", ""))
        client_channel = self.sessions.pop(client_id, None)
        if client_channel is not None:
            await self.channel_layer.send(
                client_channel, {"type": "relay.session_closed", "device_id": self.device_id, "reason": "device"}
            )
        await self.send_json({"type": "session_closed", "client_id": client_id, "reason": "device"})

    async def on_data(self, content):
        client_id = str(content.get("client_id", ""))
        client_channel = self.sessions.get(client_id)
        if client_channel is None:
            await self.send_error("E_NO_SESSION", ref=client_id)
            return
        payload = content.get("payload")
        if not isinstance(payload, dict):
            await self.send_error("E_INVALID", message="payload must be an object", ref=client_id)
            return
        await self.channel_layer.send(client_channel, {"type": "relay.data", "device_id": self.device_id, "payload": payload})

    # ── channel-layer events ─────────────────────────────────────────────────
    async def relay_session_open(self, event):
        self.sessions[event["client_id"]] = event["client_channel"]
        await self.send_json({"type": "session_open", "client_id": event["client_id"]})

    async def relay_session_closed(self, event):
        client_id = event["client_id"]
        if self.sessions.pop(client_id, None) is not None:
            await self.send_json({"type": "session_closed", "client_id": client_id, "reason": event.get("reason", "client")})

    async def relay_data(self, event):
        await self.send_json(
            {"type": "data", "client_id": event["client_id"], "device_id": event["device_id"], "payload": event["payload"]}
        )

    async def relay_pair_joined(self, event):
        if self.pairing_id is None or event.get("claim") != self.pair_claim:
            return
        self.pair_client_channel = event["client_channel"]
        await self.send_json({"type": "pair_joined"})

    async def relay_pair_msg(self, event):
        await self.send_json({"type": "pair_msg", "payload": event["payload"]})

    async def relay_revoked(self, event):
        await self.send_json({"type": "revoked", "reason": event.get("reason", "revoked")})
        self.replaced = True  # presence was already cleared by relay.services; broadcast here instead
        await self.channel_layer.group_send(
            user_group(self.user_id), {"type": "device.status", "device_id": self.device_id, "online": False}
        )
        await self.close_with(CLOSE_UNAUTHORIZED)

    async def relay_replaced(self, event):
        self.replaced = True
        await self.close_with(CLOSE_REPLACED)
