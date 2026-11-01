package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"strings"
)

// Envelope (SPEC §6):
//
//	nonce = dir (1 byte) || 0x00 0x00 0x00 || counter (8 bytes big-endian)
//	aad   = 0x01 || device_id_raw (16 bytes)
//	ciphertext||tag = AES-256-GCM(key_dir, nonce, aad, plaintext)

const (
	// DirC2D is the client→device direction (key k_c2d).
	DirC2D byte = 0x00
	// DirD2C is the device→client direction (key k_d2c).
	DirD2C byte = 0x01
	// NonceLen is the AES-GCM nonce size.
	NonceLen = 12
	// DeviceIDLen is the size of a raw device_id (UUID).
	DeviceIDLen = 16
	// MaxCounter is the last usable envelope counter (SPEC §6.3).
	MaxCounter uint64 = 1<<53 - 1
)

var (
	// ErrBadDeviceID is returned for a device_id that is not a canonical UUID.
	ErrBadDeviceID = errors.New("crypto: invalid device_id")
	// ErrCounterExhausted is returned when the counter would exceed MaxCounter.
	ErrCounterExhausted = errors.New("crypto: envelope counter exhausted")
)

// EnvelopeNonce builds the 12-byte sequential nonce.
func EnvelopeNonce(dir byte, counter uint64) []byte {
	n := make([]byte, NonceLen)
	n[0] = dir
	binary.BigEndian.PutUint64(n[4:], counter)
	return n
}

// EnvelopeAAD builds the 17-byte AAD.
func EnvelopeAAD(deviceIDRaw []byte) []byte {
	return append([]byte{0x01}, deviceIDRaw...)
}

// EnvelopeKey wraps one directional AES-256-GCM key.
type EnvelopeKey struct {
	aead cipher.AEAD
}

// NewEnvelopeKey creates the AEAD for a 32-byte key.
func NewEnvelopeKey(key []byte) (*EnvelopeKey, error) {
	if len(key) != 32 {
		return nil, ErrBadKeyLength
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &EnvelopeKey{aead: aead}, nil
}

// Seal encrypts plaintext for the given direction and counter; returns ciphertext||tag.
func (k *EnvelopeKey) Seal(dir byte, counter uint64, deviceIDRaw, plaintext []byte) ([]byte, error) {
	if counter > MaxCounter {
		return nil, ErrCounterExhausted
	}
	if len(deviceIDRaw) != DeviceIDLen {
		return nil, ErrBadDeviceID
	}
	return k.aead.Seal(nil, EnvelopeNonce(dir, counter), plaintext, EnvelopeAAD(deviceIDRaw)), nil
}

// Open authenticates and decrypts ciphertext||tag. Any failure returns an error and the caller
// MUST discard the envelope silently (SPEC §6.3).
func (k *EnvelopeKey) Open(dir byte, counter uint64, deviceIDRaw, ciphertext []byte) ([]byte, error) {
	if counter > MaxCounter {
		return nil, ErrCounterExhausted
	}
	if len(deviceIDRaw) != DeviceIDLen {
		return nil, ErrBadDeviceID
	}
	return k.aead.Open(nil, EnvelopeNonce(dir, counter), ciphertext, EnvelopeAAD(deviceIDRaw))
}

// ParseDeviceID converts a canonical lower-case UUID string into its 16 raw bytes.
func ParseDeviceID(s string) ([]byte, error) {
	if len(s) != 36 || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' {
		return nil, ErrBadDeviceID
	}
	if s != strings.ToLower(s) {
		return nil, ErrBadDeviceID
	}
	raw, err := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
	if err != nil || len(raw) != DeviceIDLen {
		return nil, ErrBadDeviceID
	}
	return raw, nil
}

// FormatDeviceID renders 16 raw bytes as a canonical UUID string.
func FormatDeviceID(raw []byte) string {
	h := hex.EncodeToString(raw)
	if len(h) != 32 {
		return ""
	}
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// B64 encodes bytes as base64url without padding (SPEC §0.2).
func B64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// B64Decode decodes base64url without padding; padded input is rejected.
func B64Decode(s string) ([]byte, error) {
	if strings.ContainsAny(s, "=+/") {
		return nil, base64.CorruptInputError(0)
	}
	return base64.RawURLEncoding.DecodeString(s)
}
