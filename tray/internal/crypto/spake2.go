package crypto

import (
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"

	"filippo.io/nistec"
	"golang.org/x/crypto/hkdf"
)

// SPAKE2-P256-SHA256-HKDF-HMAC exactly as RFC 9382 (SPEC §4.4).
//
// Tunnelio constants: A = "client" (browser, sends first, uses M), B = "device" (tray, uses N),
// AAD = "tunnelio/v1". The RFC Appendix B vector (A="server", B="client", AAD="") is also
// reproducible with this code — see TestSPAKE2Vectors.

const (
	// SPAKE2IdentityA is the identity of the client (browser) side.
	SPAKE2IdentityA = "client"
	// SPAKE2IdentityB is the identity of the device (tray) side.
	SPAKE2IdentityB = "device"
	// SPAKE2AAD is the additional data bound into the confirmation keys.
	SPAKE2AAD = "tunnelio/v1"

	spake2MHex = "02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f"
	spake2NHex = "03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49"

	pointLen = 65 // SEC1 uncompressed P-256 point
)

var (
	// ErrBadPoint is returned when a received pA/pB is not a valid, non-identity curve point.
	ErrBadPoint = errors.New("crypto: invalid SPAKE2 point")
	// ErrBadScalar is returned for a scalar that is not 32 bytes or is zero.
	ErrBadScalar = errors.New("crypto: invalid scalar")
	// ErrFinished is returned when Finish is called twice.
	ErrFinished = errors.New("crypto: SPAKE2 already finished")
)

var spake2M, spake2N = mustPoint(spake2MHex), mustPoint(spake2NHex)

func mustPoint(h string) *nistec.P256Point {
	b, err := hex.DecodeString(h)
	if err != nil {
		panic(err)
	}
	p, err := nistec.NewP256Point().SetBytes(b)
	if err != nil {
		panic(err)
	}
	return p
}

// SPAKE2Role selects which side of the exchange we are.
type SPAKE2Role int

const (
	// SPAKE2RoleA sends pA = w·M + x·G.
	SPAKE2RoleA SPAKE2Role = iota
	// SPAKE2RoleB sends pB = w·N + y·G.
	SPAKE2RoleB
)

// SPAKE2 holds the state of one exchange. Use NewSPAKE2, then Message, then Finish.
type SPAKE2 struct {
	role     SPAKE2Role
	idA, idB []byte
	aad      []byte
	w        []byte // 32 bytes big-endian, < n
	scalar   []byte // x (A) or y (B), 32 bytes
	msg      []byte // our pA or pB, 65 bytes
	done     bool
}

// SPAKE2Result is the output of a completed exchange (RFC 9382 §3.3–§4).
type SPAKE2Result struct {
	TT  []byte // transcript
	Ke  []byte // 16 bytes: shared key material (feeds the pairing key, SPEC §4.5)
	Ka  []byte // 16 bytes
	KcA []byte // 16 bytes
	KcB []byte // 16 bytes
	CA  []byte // confirmation MAC sent by A
	CB  []byte // confirmation MAC sent by B
}

// NewSPAKE2 starts an exchange with a fresh random scalar in [1, n).
func NewSPAKE2(role SPAKE2Role, idA, idB, aad, w []byte) (*SPAKE2, error) {
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return newSPAKE2WithScalar(role, idA, idB, aad, w, k.Bytes())
}

// newSPAKE2WithScalar is used by NewSPAKE2 and by the vector tests (fixed x/y).
func newSPAKE2WithScalar(role SPAKE2Role, idA, idB, aad, w, scalar []byte) (*SPAKE2, error) {
	if len(w) != 32 {
		return nil, ErrBadScalar
	}
	if len(scalar) != 32 || isZero(scalar) {
		return nil, ErrBadScalar
	}
	s := &SPAKE2{role: role, idA: cp(idA), idB: cp(idB), aad: cp(aad), w: cp(w), scalar: cp(scalar)}
	// Our message: w·(M or N) + scalar·G.
	base := spake2M
	if role == SPAKE2RoleB {
		base = spake2N
	}
	wBase, err := nistec.NewP256Point().ScalarMult(base, s.w)
	if err != nil {
		return nil, err
	}
	sg, err := nistec.NewP256Point().ScalarBaseMult(s.scalar)
	if err != nil {
		return nil, err
	}
	p := nistec.NewP256Point().Add(wBase, sg)
	if p.IsInfinity() == 1 {
		return nil, ErrBadPoint
	}
	s.msg = p.Bytes()
	return s, nil
}

// Message returns our public element (pA for role A, pB for role B), 65 bytes.
func (s *SPAKE2) Message() []byte { return cp(s.msg) }

// Finish consumes the peer's element, derives the shared secret K and the transcript, and
// returns the keys and both confirmation MACs. The peer point is validated: 65 bytes with
// prefix 0x04, on the curve, not the identity.
func (s *SPAKE2) Finish(peer []byte) (*SPAKE2Result, error) {
	if s.done {
		return nil, ErrFinished
	}
	s.done = true
	peerPt, err := parsePoint(peer)
	if err != nil {
		return nil, err
	}
	// K = scalar · (peer − w·(N or M)), with h = 1 on P-256.
	peerBase := spake2N
	if s.role == SPAKE2RoleB {
		peerBase = spake2M
	}
	wBase, err := nistec.NewP256Point().ScalarMult(peerBase, s.w)
	if err != nil {
		return nil, err
	}
	tmp := nistec.NewP256Point().Add(peerPt, nistec.NewP256Point().Negate(wBase))
	k, err := nistec.NewP256Point().ScalarMult(tmp, s.scalar)
	if err != nil {
		return nil, err
	}
	if k.IsInfinity() == 1 {
		return nil, ErrBadPoint
	}
	var pA, pB []byte
	if s.role == SPAKE2RoleA {
		pA, pB = s.msg, peer
	} else {
		pA, pB = peer, s.msg
	}
	res := spake2Derive(s.idA, s.idB, s.aad, pA, pB, k.Bytes(), s.w)
	// Scalar no longer needed.
	for i := range s.scalar {
		s.scalar[i] = 0
	}
	return res, nil
}

// spake2Derive builds TT and derives Ke, Ka, KcA, KcB, cA, cB (RFC 9382 §3.3, §4).
func spake2Derive(idA, idB, aad, pA, pB, k, w []byte) *SPAKE2Result {
	tt := make([]byte, 0, 6*8+len(idA)+len(idB)+3*pointLen+32)
	for _, part := range [][]byte{idA, idB, pA, pB, k, w} {
		var l [8]byte
		binary.LittleEndian.PutUint64(l[:], uint64(len(part)))
		tt = append(tt, l[:]...)
		tt = append(tt, part...)
	}
	digest := sha256.Sum256(tt)
	ke, ka := digest[:16], digest[16:]
	info := append([]byte("ConfirmationKeys"), aad...)
	conf := make([]byte, 32)
	if _, err := io.ReadFull(hkdf.New(sha256.New, ka, nil, info), conf); err != nil {
		panic(err) // HKDF cannot fail for 32 bytes
	}
	kcA, kcB := conf[:16], conf[16:]
	return &SPAKE2Result{
		TT:  tt,
		Ke:  cp(ke),
		Ka:  cp(ka),
		KcA: cp(kcA),
		KcB: cp(kcB),
		CA:  hmacSHA256(kcA, tt),
		CB:  hmacSHA256(kcB, tt),
	}
}

// VerifyCA checks the confirmation MAC received from A (used by B) in constant time.
func (r *SPAKE2Result) VerifyCA(mac []byte) bool { return hmac.Equal(mac, r.CA) }

// VerifyCB checks the confirmation MAC received from B (used by A) in constant time.
func (r *SPAKE2Result) VerifyCB(mac []byte) bool { return hmac.Equal(mac, r.CB) }

// PairingKey derives PK from Ke (SPEC §4.5).
func PairingKey(ke []byte) []byte {
	out := make([]byte, 32)
	if _, err := io.ReadFull(hkdf.New(sha256.New, ke, nil, []byte("tunnelio/v1/pairing-key")), out); err != nil {
		panic(err)
	}
	return out
}

// PairingID derives the 16-byte pairing identifier from PK (SPEC §4.6).
func PairingID(pk []byte) []byte {
	h := sha256.New()
	h.Write([]byte("tunnelio/v1/pairing-id"))
	h.Write(pk)
	return h.Sum(nil)[:16]
}

func parsePoint(b []byte) (*nistec.P256Point, error) {
	if len(b) != pointLen || b[0] != 0x04 {
		return nil, ErrBadPoint
	}
	p, err := nistec.NewP256Point().SetBytes(b)
	if err != nil || p.IsInfinity() == 1 {
		return nil, ErrBadPoint
	}
	return p, nil
}

func hmacSHA256(key, msg []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(msg)
	return m.Sum(nil)
}

func isZero(b []byte) bool {
	var acc byte
	for _, x := range b {
		acc |= x
	}
	return acc == 0
}

func cp(b []byte) []byte {
	if b == nil {
		return nil
	}
	out := make([]byte, len(b))
	copy(out, b)
	return out
}
