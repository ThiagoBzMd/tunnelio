#!/usr/bin/env python3
"""
Reference vector generator for the Tunnelio protocol (docs/SPEC.md).

This file is NOT part of any product build. It is a small, readable reference
implementation of the cryptographic constructions defined in SPEC.md, used to
produce the JSON test vectors in this directory. Both real implementations
(tray/ in Go, web/ in TypeScript) MUST reproduce these vectors byte for byte.

Run:  python3 gen_vectors.py            (requires: cryptography, argon2-cffi)

Sections (mirrors SPEC.md numbering):
  V1  Pairing code  -> SPAKE2 scalar w
  V2  SPAKE2-P256-SHA256-HKDF-HMAC   (RFC 9382 Appendix B vectors re-checked,
                                      then a Tunnelio-specific run)
  V3  Pairing key PK and pairing_id derived from SPAKE2 Ke
  V4  Session handshake (X25519 + HKDF) -> directional keys + confirm MACs
  V5  Envelope (AES-256-GCM, sequential nonce)
  V6  Crockford base32 (recovery code) with check symbol
  V7  Vault (Argon2id key wrap, per-conversation key, blob)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets as _secrets  # noqa: F401  (not used: vectors are deterministic)
import struct
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF, HKDFExpand

OUT = Path(__file__).parent

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def h(b: bytes) -> str:
    return b.hex()


def sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def sha512(b: bytes) -> bytes:
    return hashlib.sha512(b).digest()


def hmac_sha256(key: bytes, msg: bytes) -> bytes:
    return hmac.new(key, msg, hashlib.sha256).digest()


def hkdf(ikm: bytes, salt: bytes | None, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def hkdf_extract(salt: bytes, ikm: bytes) -> bytes:
    # RFC 5869: PRK = HMAC-Hash(salt, IKM)
    return hmac_sha256(salt, ikm)


def hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    return HKDFExpand(algorithm=hashes.SHA256(), length=length, info=info).derive(prk)


def len8le(b: bytes) -> bytes:
    return struct.pack("<Q", len(b))


# ─────────────────────────────────────────────────────────────────────────────
# Minimal P-256 arithmetic (affine, educational — NOT constant time).
# Only used here to produce vectors. Real implementations use vetted libraries
# (Go: filippo.io/nistec; TS: @noble/curves).
# ─────────────────────────────────────────────────────────────────────────────

P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296
GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5
INF = None


def inv(x: int) -> int:
    return pow(x, P - 2, P)


def pt_add(p1, p2):
    if p1 is INF:
        return p2
    if p2 is INF:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2:
        if (y1 + y2) % P == 0:
            return INF
        lam = (3 * x1 * x1 + A) * inv(2 * y1) % P
    else:
        lam = (y2 - y1) * inv(x2 - x1) % P
    x3 = (lam * lam - x1 - x2) % P
    y3 = (lam * (x1 - x3) - y1) % P
    return (x3, y3)


def pt_mul(k: int, p):
    r = INF
    q = p
    while k:
        if k & 1:
            r = pt_add(r, q)
        q = pt_add(q, q)
        k >>= 1
    return r


def pt_neg(p):
    if p is INF:
        return INF
    return (p[0], (-p[1]) % P)


def pt_from_bytes(b: bytes):
    if b[0] == 0x04 and len(b) == 65:
        return (int.from_bytes(b[1:33], "big"), int.from_bytes(b[33:], "big"))
    if b[0] in (0x02, 0x03) and len(b) == 33:
        x = int.from_bytes(b[1:], "big")
        y2 = (pow(x, 3, P) + A * x + B) % P
        y = pow(y2, (P + 1) // 4, P)  # P ≡ 3 (mod 4)
        if (y & 1) != (b[0] & 1):
            y = P - y
        return (x, y)
    raise ValueError("bad point encoding")


def pt_to_bytes(p) -> bytes:  # SEC1 uncompressed, as in RFC 9382 vectors
    return b"\x04" + p[0].to_bytes(32, "big") + p[1].to_bytes(32, "big")


G = (GX, GY)
M = pt_from_bytes(bytes.fromhex("02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f"))
NPT = pt_from_bytes(bytes.fromhex("03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49"))


# ─────────────────────────────────────────────────────────────────────────────
# SPAKE2-P256-SHA256-HKDF-HMAC (RFC 9382)
# ─────────────────────────────────────────────────────────────────────────────

def spake2_run(a_id: bytes, b_id: bytes, aad: bytes, w: int, x: int, y: int) -> dict:
    pA = pt_add(pt_mul(w, M), pt_mul(x, G))
    pB = pt_add(pt_mul(w, NPT), pt_mul(y, G))
    # A computes h*x*(pB - w*N); B computes h*y*(pA - w*M). h = 1 for P-256.
    K_a = pt_mul(x, pt_add(pB, pt_neg(pt_mul(w, NPT))))
    K_b = pt_mul(y, pt_add(pA, pt_neg(pt_mul(w, M))))
    assert K_a == K_b
    K = K_a
    pA_b, pB_b, K_b_ = pt_to_bytes(pA), pt_to_bytes(pB), pt_to_bytes(K)
    w_b = w.to_bytes(32, "big")
    TT = (len8le(a_id) + a_id + len8le(b_id) + b_id + len8le(pA_b) + pA_b
          + len8le(pB_b) + pB_b + len8le(K_b_) + K_b_ + len8le(w_b) + w_b)
    digest = sha256(TT)
    Ke, Ka = digest[:16], digest[16:]
    conf = hkdf(Ka, None, b"ConfirmationKeys" + aad, 32)
    KcA, KcB = conf[:16], conf[16:]
    cA = hmac_sha256(KcA, TT)
    cB = hmac_sha256(KcB, TT)
    return {
        "A": a_id.decode(), "B": b_id.decode(), "AAD": aad.decode(),
        "w": h(w_b), "x": h(x.to_bytes(32, "big")), "y": h(y.to_bytes(32, "big")),
        "pA": h(pA_b), "pB": h(pB_b), "K": h(K_b_), "TT": h(TT),
        "hash_TT": h(digest), "Ke": h(Ke), "Ka": h(Ka), "KcA": h(KcA), "KcB": h(KcB),
        "cA": h(cA), "cB": h(cB),
    }


def check_rfc_vector():
    """Re-derive RFC 9382 Appendix B, first vector (A='server', B='client')."""
    v = spake2_run(
        b"server", b"client", b"",
        w=0x2EE57912099D31560B3A44B1184B9B4866E904C49D12AC5042C97DCA461B1A5F,
        x=0x43DD0FD7215BDCB482879FCA3220C6A968E66D70B1356CAC18BB26C84A78D729,
        y=0xDCB60106F276B02606D8EF0A328C02E4B629F84F89786AF5BEFB0BC75B6E66BE,
    )
    assert v["pA"] == ("04a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751470"
                       "f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c"), v["pA"]
    assert v["Ke"] == "0e0672dc86f8e45565d338b0540abe69", v["Ke"]
    assert v["KcA"] == "00c12546835755c86d8c0db7851ae86f", v["KcA"]
    assert v["cA"] == "58ad4aa88e0b60d5061eb6b5dd93e80d9c4f00d127c65b3b35b1b5281fee38f0", v["cA"]
    assert v["cB"] == "d3e2e547f1ae04f2dbdbf0fc4b79f8ecff2dff314b5d32fe9fcef2fb26dc459b", v["cB"]
    return v


# ─────────────────────────────────────────────────────────────────────────────
# Tunnelio constructions (SPEC.md)
# ─────────────────────────────────────────────────────────────────────────────

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
CROCKFORD_CHECK = CROCKFORD + "*~$=U"


def normalize_code(s: str) -> str:
    s = s.upper().replace("-", "").replace(" ", "")
    s = s.replace("I", "1").replace("L", "1").replace("O", "0")
    return s


def code_to_w(code: str) -> int:
    pw = normalize_code(code).encode("ascii")
    return int.from_bytes(sha512(pw), "big") % N


def pairing_key_from_Ke(Ke: bytes) -> bytes:
    return hkdf(Ke, None, b"tunnelio/v1/pairing-key", 32)


def pairing_id_from_PK(PK: bytes) -> bytes:
    return sha256(b"tunnelio/v1/pairing-id" + PK)[:16]


def session_keys(PK: bytes, pairing_id: bytes, priv_c: bytes, priv_d: bytes) -> dict:
    kc = X25519PrivateKey.from_private_bytes(priv_c)
    kd = X25519PrivateKey.from_private_bytes(priv_d)
    pub_c = kc.public_key().public_bytes_raw()
    pub_d = kd.public_key().public_bytes_raw()
    ss_c = kc.exchange(X25519PublicKey.from_public_bytes(pub_d))
    ss_d = kd.exchange(X25519PublicKey.from_public_bytes(pub_c))
    assert ss_c == ss_d
    hello_c = b"\x01" + pairing_id + pub_c
    hello_d = b"\x01" + pub_d
    th = sha256(hello_c + hello_d)
    prk = hkdf_extract(PK, ss_c)
    k_c2d = hkdf_expand(prk, b"tunnelio/v1/c2d" + th, 32)
    k_d2c = hkdf_expand(prk, b"tunnelio/v1/d2c" + th, 32)
    k_conf_c = hkdf_expand(prk, b"tunnelio/v1/confirm-c" + th, 32)
    k_conf_d = hkdf_expand(prk, b"tunnelio/v1/confirm-d" + th, 32)
    mac_d = hmac_sha256(k_conf_d, th)
    mac_c = hmac_sha256(k_conf_c, th)
    return {
        "PK": h(PK), "pairing_id": h(pairing_id),
        "eph_priv_c": h(priv_c), "eph_pub_c": h(pub_c),
        "eph_priv_d": h(priv_d), "eph_pub_d": h(pub_d),
        "shared_secret": h(ss_c),
        "hello_c_bytes": h(hello_c), "hello_d_bytes": h(hello_d),
        "transcript_hash": h(th), "prk": h(prk),
        "k_c2d": h(k_c2d), "k_d2c": h(k_d2c),
        "k_conf_c": h(k_conf_c), "k_conf_d": h(k_conf_d),
        "mac_d": h(mac_d), "mac_c": h(mac_c),
        "_keys": {"k_c2d": k_c2d, "k_d2c": k_d2c},
    }


def envelope_nonce(direction: int, counter: int) -> bytes:
    return bytes([direction]) + b"\x00\x00\x00" + struct.pack(">Q", counter)


def envelope_aad(device_id_raw: bytes) -> bytes:
    return b"\x01" + device_id_raw


def seal(key: bytes, direction: int, counter: int, device_id_raw: bytes, plaintext: bytes) -> dict:
    nonce = envelope_nonce(direction, counter)
    aad = envelope_aad(device_id_raw)
    ct = AESGCM(key).encrypt(nonce, plaintext, aad)
    return {"direction": direction, "counter": counter, "nonce": h(nonce), "aad": h(aad),
            "plaintext": plaintext.decode("utf-8"), "ciphertext_with_tag": h(ct)}


def crockford_encode(data: bytes, with_check: bool) -> str:
    n = int.from_bytes(data, "big")
    nbits = len(data) * 8
    nchars = -(-nbits // 5)
    out = []
    for i in range(nchars):
        shift = 5 * (nchars - 1 - i)
        out.append(CROCKFORD[(n >> shift) & 31])
    s = "".join(out)
    if with_check:
        s += CROCKFORD_CHECK[n % 37]
    return s


def group4(s: str) -> str:
    return "-".join(s[i:i + 4] for i in range(0, len(s), 4))


def vault_vectors() -> dict:
    from argon2.low_level import Type, hash_secret_raw
    password = "correct horse battery staple"
    salt = bytes.fromhex("000102030405060708090a0b0c0d0e0f")
    kek = hash_secret_raw(password.encode("utf-8"), salt, time_cost=3, memory_cost=65536,
                          parallelism=1, hash_len=32, type=Type.ID)
    vault_key = bytes(range(0x20, 0x40))
    wrap_nonce = bytes.fromhex("a0a1a2a3a4a5a6a7a8a9aaab")
    wrapped = AESGCM(kek).encrypt(wrap_nonce, vault_key, b"tunnelio/vault/v1")
    cid = bytes.fromhex("7d2e1c4a9b8f4e0d8c3b2a1f0e9d8c7b")
    ck = hkdf(vault_key, None, b"tunnelio/vault/v1/conversation" + cid, 32)
    seq = 0
    blob_nonce = bytes.fromhex("b0b1b2b3b4b5b6b7b8b9babb")
    header = json.dumps({"type": "header", "title": "Olá, mundo", "model": "llama3.2:3b",
                         "created_at": "2026-10-08T12:00:00Z"}, ensure_ascii=False,
                        separators=(",", ":")).encode("utf-8")
    blob_ct = AESGCM(ck).encrypt(blob_nonce, header, cid + struct.pack(">I", seq))
    stored = blob_nonce + blob_ct
    rec = crockford_encode(vault_key, with_check=True)
    return {
        "argon2id": {"password": password, "salt": h(salt), "m_kib": 65536, "t": 3, "p": 1,
                     "tag_len": 32, "kek": h(kek)},
        "wrap": {"vault_key": h(vault_key), "nonce": h(wrap_nonce), "aad": "tunnelio/vault/v1",
                 "wrapped_with_tag": h(wrapped)},
        "recovery_code": {"raw": rec, "display": group4(rec)},
        "conversation_key": {"conversation_id": h(cid), "info_label": "tunnelio/vault/v1/conversation",
                             "ck": h(ck)},
        "blob": {"seq": seq, "nonce": h(blob_nonce), "aad": h(cid + struct.pack(">I", seq)),
                 "plaintext": header.decode("utf-8"), "stored_bytes": h(stored)},
    }


def login_keys(email: str, password: str) -> dict:
    """V8 (v1.2): one password → auth key (sent to the server) + vault KEK (never leaves the browser)."""
    from argon2.low_level import Type, hash_secret_raw
    import unicodedata
    email_norm = email.strip().lower().encode("utf-8")
    salt = sha256(b"tunnelio/auth/v1" + email_norm)[:16]
    pw = unicodedata.normalize("NFC", password).encode("utf-8")
    master = hash_secret_raw(pw, salt, time_cost=3, memory_cost=65536, parallelism=1, hash_len=32, type=Type.ID)
    auth_key = hkdf(master, None, b"tunnelio/auth/v1/login", 32)
    vault_kek = hkdf(master, None, b"tunnelio/auth/v1/vault", 32)  # v1.2 only; kept for the record
    import base64
    return {
        "email": email, "email_normalized": email_norm.decode(), "password": password,
        "salt": h(salt), "master": h(master),
        "auth_key": h(auth_key), "auth_key_b64url": base64.urlsafe_b64encode(auth_key).rstrip(b"=").decode(),
        "vault_kek": h(vault_kek),
        "pairings_key": h(hkdf(master, None, b"tunnelio/auth/v1/pairings", 32)),
        "_note": "auth_key_b64url is what the browser sends as the `password` field; pairings_key (v1.3) seals the synced pairings blob and derives from the same master",
    }


def main():
    rfc = check_rfc_vector()

    # V1: pairing code -> w
    code = "K7M3-ABCD-EFGH"
    w = code_to_w(code)
    v1 = {
        "code_display": code, "code_normalized": normalize_code(code),
        "password_bytes": h(normalize_code(code).encode()),
        "sha512": h(sha512(normalize_code(code).encode())),
        "w": h(w.to_bytes(32, "big")),
        "normalization_examples": {
            "k7m3-abcd-efgh": normalize_code("k7m3-abcd-efgh"),
            "K7M3 ABCD EFGH": normalize_code("K7M3 ABCD EFGH"),
            "K7M3-ABCD-EFGI": normalize_code("K7M3-ABCD-EFGI"),  # I -> 1
            "K7M3-ABCD-EFGO": normalize_code("K7M3-ABCD-EFGO"),  # O -> 0
            "K7M3-ABCD-EFGL": normalize_code("K7M3-ABCD-EFGL"),  # L -> 1
        },
    }

    # V2: SPAKE2 Tunnelio run (deterministic x, y for the vector only!)
    x = int.from_bytes(sha256(b"tunnelio vector x"), "big") % N
    y = int.from_bytes(sha256(b"tunnelio vector y"), "big") % N
    v2 = spake2_run(b"client", b"device", b"tunnelio/v1", w, x, y)

    # V3: PK + pairing_id
    Ke = bytes.fromhex(v2["Ke"])
    PK = pairing_key_from_Ke(Ke)
    pid = pairing_id_from_PK(PK)
    v3 = {"Ke": h(Ke), "PK": h(PK), "pairing_id": h(pid)}

    # V4: session keys
    priv_c = bytes.fromhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")  # RFC 7748 Alice
    priv_d = bytes.fromhex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")  # RFC 7748 Bob
    v4 = session_keys(PK, pid, priv_c, priv_d)
    keys = v4.pop("_keys")

    # V5: envelopes
    device_id = "0192f6a0-5e7b-7c3d-9a4e-1b2c3d4e5f60"
    device_raw = bytes.fromhex(device_id.replace("-", ""))
    msg0 = json.dumps({"type": "list_models", "id": "r1"}, separators=(",", ":")).encode()
    msg1 = json.dumps({"type": "chat", "id": "r2", "conversation_id": "c1", "mode": "private",
                       "model": "llama3.2:3b", "messages": [{"role": "user", "content": "Oi"}]},
                      separators=(",", ":")).encode()
    rep0 = json.dumps({"type": "models", "id": "r1", "models": []}, separators=(",", ":")).encode()
    v5 = {
        "device_id": device_id, "device_id_raw": h(device_raw),
        "k_c2d": h(keys["k_c2d"]), "k_d2c": h(keys["k_d2c"]),
        "frames": [
            seal(keys["k_c2d"], 0, 0, device_raw, msg0),
            seal(keys["k_c2d"], 0, 1, device_raw, msg1),
            seal(keys["k_d2c"], 1, 0, device_raw, rep0),
        ],
    }

    # V6: Crockford
    key32 = bytes(range(32))
    v6 = {
        "input": h(key32),
        "encoded_52": crockford_encode(key32, with_check=False),
        "encoded_53_with_check": crockford_encode(key32, with_check=True),
        "display": group4(crockford_encode(key32, with_check=True)),
        "alphabet": CROCKFORD, "check_alphabet": CROCKFORD_CHECK,
    }

    # V7: vault
    v7 = vault_vectors()

    # V8: single-password derivation
    v8 = login_keys("  Test.User@Example.com ", "correct horse battery staple")

    out = {
        "_about": "Tunnelio protocol test vectors. Generated by gen_vectors.py. See docs/SPEC.md.",
        "_protocol_version": 1,
        "V1_pairing_code_to_w": v1,
        "V2_spake2_rfc9382_check": rfc,
        "V2_spake2_tunnelio": v2,
        "V3_pairing_key": v3,
        "V4_session_handshake": v4,
        "V5_envelope": v5,
        "V6_crockford_base32": v6,
        "V7_vault": v7,
        "V8_login_keys": v8,
    }
    (OUT / "vectors.json").write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    print("wrote", OUT / "vectors.json")


if __name__ == "__main__":
    main()
