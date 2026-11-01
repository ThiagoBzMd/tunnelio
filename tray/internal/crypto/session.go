package crypto

import (
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"

	"golang.org/x/crypto/hkdf"
)

// Session handshake derivation (SPEC §5.2):
//
//	hello_c_bytes = 0x01 || pairing_id (16) || eph_pub_c (32)
//	hello_d_bytes = 0x01 || eph_pub_d (32)
//	th   = SHA-256(hello_c_bytes || hello_d_bytes)
//	ss   = X25519(eph_priv_self, eph_pub_peer)      (all-zero output rejected)
//	prk  = HMAC-SHA256(PK, ss)                      (= HKDF-Extract with salt PK)
//	k_*  = HKDF-Expand(prk, label || th, 32)
//	mac_d = HMAC(k_conf_d, th)   mac_c = HMAC(k_conf_c, th)

const (
	// X25519KeyLen is the size of an X25519 public key.
	X25519KeyLen = 32
	// PairingIDLen is the size of pairing_id.
	PairingIDLen = 16
)

var (
	// ErrBadKeyLength is returned for a PK, pairing_id or public key of the wrong size.
	ErrBadKeyLength = errors.New("crypto: bad key length")
	// ErrLowOrderPoint is returned when the X25519 shared secret is all zero (RFC 7748 §6.1).
	ErrLowOrderPoint = errors.New("crypto: X25519 low-order point")
)

// SessionKeys are the per-session directional keys and confirmation MACs.
type SessionKeys struct {
	TranscriptHash []byte // th
	C2D            []byte // k_c2d
	D2C            []byte // k_d2c
	ConfC          []byte // k_conf_c
	ConfD          []byte // k_conf_d
	MACC           []byte // mac_c (sent by the client in confirm)
	MACD           []byte // mac_d (sent by the device in hello_ack)
}

// NewEphemeral generates an X25519 key pair for one session.
func NewEphemeral() (*ecdh.PrivateKey, error) {
	return ecdh.X25519().GenerateKey(rand.Reader)
}

// DeriveSessionKeysDevice is the device-side derivation: our ephemeral private key and the
// client's public key from hello.
func DeriveSessionKeysDevice(pk, pairingID, ephPubC []byte, ephPrivD *ecdh.PrivateKey) (*SessionKeys, error) {
	ss, err := x25519(ephPrivD, ephPubC)
	if err != nil {
		return nil, err
	}
	return deriveSession(pk, pairingID, ephPubC, ephPrivD.PublicKey().Bytes(), ss)
}

// DeriveSessionKeysClient is the client-side derivation (used by tests and interop tooling).
func DeriveSessionKeysClient(pk, pairingID []byte, ephPrivC *ecdh.PrivateKey, ephPubD []byte) (*SessionKeys, error) {
	ss, err := x25519(ephPrivC, ephPubD)
	if err != nil {
		return nil, err
	}
	return deriveSession(pk, pairingID, ephPrivC.PublicKey().Bytes(), ephPubD, ss)
}

func x25519(priv *ecdh.PrivateKey, peerPub []byte) ([]byte, error) {
	if len(peerPub) != X25519KeyLen {
		return nil, ErrBadKeyLength
	}
	pub, err := ecdh.X25519().NewPublicKey(peerPub)
	if err != nil {
		return nil, err
	}
	ss, err := priv.ECDH(pub)
	if err != nil {
		return nil, err
	}
	if isZero(ss) {
		return nil, ErrLowOrderPoint
	}
	return ss, nil
}

func deriveSession(pk, pairingID, pubC, pubD, ss []byte) (*SessionKeys, error) {
	if len(pk) != 32 || len(pairingID) != PairingIDLen || len(pubC) != X25519KeyLen || len(pubD) != X25519KeyLen {
		return nil, ErrBadKeyLength
	}
	h := sha256.New()
	h.Write([]byte{0x01})
	h.Write(pairingID)
	h.Write(pubC)
	h.Write([]byte{0x01})
	h.Write(pubD)
	th := h.Sum(nil)

	prk := hkdf.Extract(sha256.New, ss, pk)
	expand := func(label string) []byte {
		out := make([]byte, 32)
		info := append([]byte(label), th...)
		if _, err := io.ReadFull(hkdf.Expand(sha256.New, prk, info), out); err != nil {
			panic(err)
		}
		return out
	}
	k := &SessionKeys{
		TranscriptHash: th,
		C2D:            expand("tunnelio/v1/c2d"),
		D2C:            expand("tunnelio/v1/d2c"),
		ConfC:          expand("tunnelio/v1/confirm-c"),
		ConfD:          expand("tunnelio/v1/confirm-d"),
	}
	k.MACC = hmacSHA256(k.ConfC, th)
	k.MACD = hmacSHA256(k.ConfD, th)
	for i := range prk {
		prk[i] = 0
	}
	for i := range ss {
		ss[i] = 0
	}
	return k, nil
}

// VerifyMAC compares two MACs in constant time.
func VerifyMAC(got, want []byte) bool { return hmac.Equal(got, want) }
