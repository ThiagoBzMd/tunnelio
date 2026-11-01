// Package crypto holds the protocol primitives implemented from SPEC.md and verified against
// docs/vectors/vectors.json:
//
//   - spake2.go   SPAKE2-P256-SHA256-HKDF-HMAC (RFC 9382) over filippo.io/nistec.
//   - session.go  X25519 (crypto/ecdh) + HKDF-SHA256 directional keys and confirm MACs (SPEC §5).
//   - envelope.go AES-256-GCM with nonce = dir||000||counter and aad = 0x01||device_id (SPEC §6).
//   - code.go     pairing code (Crockford base32) normalization and w derivation (SPEC §2.1, §4.3).
//
// Nothing here touches the account's password or the keys derived from it: only the browser
// derives those (SPEC §10).
package crypto
