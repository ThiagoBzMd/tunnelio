# relay — blind WebSocket relay

Consumers (Django Channels) for `/ws/client` and `/ws/device`. The relay reads **only**
routing metadata (`type`, `device_id`, `client_id`, `claim`, frame size) and forwards
`payload` untouched. Frame catalogue, close codes, limits and keepalive: `docs/SPEC.md` §3.

## Minimal interface with the rest of the system (SPEC §3.9)

Needs from other apps:

```
authenticate_client(cookie, origin)        -> user_id | None
authenticate_device(bearer_token)          -> (device_id, user_id) | None   # sha256(token) == Device.token_hash (a revoked device is deleted)
pairing_bind(claim, device_name, user_id)  -> (device_id, device_token)     # creates Device on first pairing; idempotent afterwards
on_connection_closed(metadata)             -> ConnectionLog row
```

Provides to other apps:

```
is_online(device_id) -> bool
disconnect_device(device_id, reason)       # used by DELETE /api/devices/{id} and account deletion
```

Channel-layer groups: `user.<id>` (presence broadcasts to all client connections of a user),
`device.<id>` (one live connection per device; a new one replaces the old with 4006) and, per
browser sign-in, `login.row.<id>` (the `accounts.LoginSession` row; `login.key.<hash>` for a
session without a row). Signing a session out (`accounts.sessions.revoke`) sends `session.revoked`
to that group and the browser's socket closes with 4001. The row survives the session key change
Django makes on a password change, so the current browser keeps its socket.

Rewriting this app as a Go sidecar means implementing the same four inbound calls over an
internal HTTP endpoint and the two outbound ones as HTTP calls from Django. Nothing else
depends on the relay's internals.
