package crypto

import (
	"bytes"
	"crypto/ecdh"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// vectorsPath is docs/vectors/vectors.json relative to this package.
const vectorsPath = "../../../docs/vectors/vectors.json"

type vectors struct {
	V1 struct {
		CodeDisplay    string            `json:"code_display"`
		CodeNormalized string            `json:"code_normalized"`
		PasswordBytes  string            `json:"password_bytes"`
		SHA512         string            `json:"sha512"`
		W              string            `json:"w"`
		Examples       map[string]string `json:"normalization_examples"`
	} `json:"V1_pairing_code_to_w"`
	V2RFC      spake2Vector `json:"V2_spake2_rfc9382_check"`
	V2Tunnelio spake2Vector `json:"V2_spake2_tunnelio"`
	V3         struct {
		Ke        string `json:"Ke"`
		PK        string `json:"PK"`
		PairingID string `json:"pairing_id"`
	} `json:"V3_pairing_key"`
	V4 struct {
		PK             string `json:"PK"`
		PairingID      string `json:"pairing_id"`
		EphPrivC       string `json:"eph_priv_c"`
		EphPubC        string `json:"eph_pub_c"`
		EphPrivD       string `json:"eph_priv_d"`
		EphPubD        string `json:"eph_pub_d"`
		SharedSecret   string `json:"shared_secret"`
		TranscriptHash string `json:"transcript_hash"`
		KC2D           string `json:"k_c2d"`
		KD2C           string `json:"k_d2c"`
		KConfC         string `json:"k_conf_c"`
		KConfD         string `json:"k_conf_d"`
		MACD           string `json:"mac_d"`
		MACC           string `json:"mac_c"`
	} `json:"V4_session_handshake"`
	V5 struct {
		DeviceID    string `json:"device_id"`
		DeviceIDRaw string `json:"device_id_raw"`
		KC2D        string `json:"k_c2d"`
		KD2C        string `json:"k_d2c"`
		Frames      []struct {
			Direction         int    `json:"direction"`
			Counter           uint64 `json:"counter"`
			Nonce             string `json:"nonce"`
			AAD               string `json:"aad"`
			Plaintext         string `json:"plaintext"`
			CiphertextWithTag string `json:"ciphertext_with_tag"`
		} `json:"frames"`
	} `json:"V5_envelope"`
}

type spake2Vector struct {
	A, B, AAD string
	W         string `json:"w"`
	X         string `json:"x"`
	Y         string `json:"y"`
	PA        string `json:"pA"`
	PB        string `json:"pB"`
	K         string `json:"K"`
	TT        string `json:"TT"`
	HashTT    string `json:"hash_TT"`
	Ke        string `json:"Ke"`
	Ka        string `json:"Ka"`
	KcA       string `json:"KcA"`
	KcB       string `json:"KcB"`
	CA        string `json:"cA"`
	CB        string `json:"cB"`
}

func loadVectors(t *testing.T) *vectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean(vectorsPath))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	return &v
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}

func assertHex(t *testing.T, name string, got []byte, wantHex string) {
	t.Helper()
	if hex.EncodeToString(got) != wantHex {
		t.Errorf("%s mismatch:\n got %x\nwant %s", name, got, wantHex)
	}
}

func TestV1PairingCodeToW(t *testing.T) {
	v := loadVectors(t)
	if got := NormalizeCode(v.V1.CodeDisplay); got != v.V1.CodeNormalized {
		t.Errorf("normalize: got %q want %q", got, v.V1.CodeNormalized)
	}
	for in, want := range v.V1.Examples {
		if got := NormalizeCode(in); got != want {
			t.Errorf("normalize(%q): got %q want %q", in, got, want)
		}
	}
	if got := hex.EncodeToString([]byte(v.V1.CodeNormalized)); got != v.V1.PasswordBytes {
		t.Errorf("password bytes: got %s want %s", got, v.V1.PasswordBytes)
	}
	w, err := CodeToW(v.V1.CodeDisplay)
	if err != nil {
		t.Fatal(err)
	}
	assertHex(t, "w", w, v.V1.W)
	if FormatCode(v.V1.CodeNormalized) != v.V1.CodeDisplay {
		t.Errorf("format: got %q", FormatCode(v.V1.CodeNormalized))
	}
	if _, err := CodeToW("K7M3-ABCD-EFG"); err == nil {
		t.Error("short code accepted")
	}
	if _, err := CodeToW("K7M3-ABCD-EFGU"); err == nil {
		t.Error("code with U accepted")
	}
}

func runSPAKE2Vector(t *testing.T, vec spake2Vector) {
	t.Helper()
	a, err := newSPAKE2WithScalar(SPAKE2RoleA, []byte(vec.A), []byte(vec.B), []byte(vec.AAD), unhex(t, vec.W), unhex(t, vec.X))
	if err != nil {
		t.Fatal(err)
	}
	b, err := newSPAKE2WithScalar(SPAKE2RoleB, []byte(vec.A), []byte(vec.B), []byte(vec.AAD), unhex(t, vec.W), unhex(t, vec.Y))
	if err != nil {
		t.Fatal(err)
	}
	assertHex(t, "pA", a.Message(), vec.PA)
	assertHex(t, "pB", b.Message(), vec.PB)
	ra, err := a.Finish(b.Message())
	if err != nil {
		t.Fatal(err)
	}
	rb, err := b.Finish(a.Message())
	if err != nil {
		t.Fatal(err)
	}
	for name, r := range map[string]*SPAKE2Result{"A": ra, "B": rb} {
		assertHex(t, name+" TT", r.TT, vec.TT)
		assertHex(t, name+" Ke", r.Ke, vec.Ke)
		assertHex(t, name+" Ka", r.Ka, vec.Ka)
		assertHex(t, name+" KcA", r.KcA, vec.KcA)
		assertHex(t, name+" KcB", r.KcB, vec.KcB)
		assertHex(t, name+" cA", r.CA, vec.CA)
		assertHex(t, name+" cB", r.CB, vec.CB)
	}
	// K appears inside TT; check it explicitly.
	k := unhex(t, vec.K)
	if !bytes.Contains(ra.TT, k) {
		t.Error("K not found in transcript")
	}
	if !rb.VerifyCA(ra.CA) || !ra.VerifyCB(rb.CB) {
		t.Error("confirmation MACs do not verify")
	}
}

func TestV2SPAKE2RFC9382(t *testing.T) { runSPAKE2Vector(t, loadVectors(t).V2RFC) }

func TestV2SPAKE2Tunnelio(t *testing.T) { runSPAKE2Vector(t, loadVectors(t).V2Tunnelio) }

func TestV3PairingKey(t *testing.T) {
	v := loadVectors(t)
	pk := PairingKey(unhex(t, v.V3.Ke))
	assertHex(t, "PK", pk, v.V3.PK)
	assertHex(t, "pairing_id", PairingID(pk), v.V3.PairingID)
}

func TestV4SessionHandshake(t *testing.T) {
	v := loadVectors(t)
	privC, err := ecdh.X25519().NewPrivateKey(unhex(t, v.V4.EphPrivC))
	if err != nil {
		t.Fatal(err)
	}
	privD, err := ecdh.X25519().NewPrivateKey(unhex(t, v.V4.EphPrivD))
	if err != nil {
		t.Fatal(err)
	}
	assertHex(t, "eph_pub_c", privC.PublicKey().Bytes(), v.V4.EphPubC)
	assertHex(t, "eph_pub_d", privD.PublicKey().Bytes(), v.V4.EphPubD)
	pk, pid := unhex(t, v.V4.PK), unhex(t, v.V4.PairingID)

	kd, err := DeriveSessionKeysDevice(pk, pid, privC.PublicKey().Bytes(), privD)
	if err != nil {
		t.Fatal(err)
	}
	kc, err := DeriveSessionKeysClient(pk, pid, privC, privD.PublicKey().Bytes())
	if err != nil {
		t.Fatal(err)
	}
	for name, k := range map[string]*SessionKeys{"device": kd, "client": kc} {
		assertHex(t, name+" th", k.TranscriptHash, v.V4.TranscriptHash)
		assertHex(t, name+" k_c2d", k.C2D, v.V4.KC2D)
		assertHex(t, name+" k_d2c", k.D2C, v.V4.KD2C)
		assertHex(t, name+" k_conf_c", k.ConfC, v.V4.KConfC)
		assertHex(t, name+" k_conf_d", k.ConfD, v.V4.KConfD)
		assertHex(t, name+" mac_c", k.MACC, v.V4.MACC)
		assertHex(t, name+" mac_d", k.MACD, v.V4.MACD)
	}
	// Low-order peer key must be rejected.
	if _, err := DeriveSessionKeysDevice(pk, pid, make([]byte, 32), privD); err == nil {
		t.Error("all-zero peer public key accepted")
	}
}

func TestV5Envelope(t *testing.T) {
	v := loadVectors(t)
	raw, err := ParseDeviceID(v.V5.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	assertHex(t, "device_id_raw", raw, v.V5.DeviceIDRaw)
	if FormatDeviceID(raw) != v.V5.DeviceID {
		t.Errorf("FormatDeviceID: %q", FormatDeviceID(raw))
	}
	keys := map[int]*EnvelopeKey{}
	for dir, kh := range map[int]string{0: v.V5.KC2D, 1: v.V5.KD2C} {
		k, err := NewEnvelopeKey(unhex(t, kh))
		if err != nil {
			t.Fatal(err)
		}
		keys[dir] = k
	}
	for i, f := range v.V5.Frames {
		dir := DirC2D
		if f.Direction == 1 {
			dir = DirD2C
		}
		assertHex(t, "nonce", EnvelopeNonce(dir, f.Counter), f.Nonce)
		assertHex(t, "aad", EnvelopeAAD(raw), f.AAD)
		ct, err := keys[f.Direction].Seal(dir, f.Counter, raw, []byte(f.Plaintext))
		if err != nil {
			t.Fatal(err)
		}
		assertHex(t, "frame ciphertext", ct, f.CiphertextWithTag)
		pt, err := keys[f.Direction].Open(dir, f.Counter, raw, unhex(t, f.CiphertextWithTag))
		if err != nil {
			t.Fatalf("frame %d open: %v", i, err)
		}
		if string(pt) != f.Plaintext {
			t.Errorf("frame %d plaintext mismatch", i)
		}
		// Wrong counter, wrong direction key and wrong device_id must all fail.
		if _, err := keys[f.Direction].Open(dir, f.Counter+1, raw, ct); err == nil {
			t.Error("open with wrong counter succeeded")
		}
		if _, err := keys[1-f.Direction].Open(dir, f.Counter, raw, ct); err == nil {
			t.Error("open with wrong key succeeded")
		}
		other := append([]byte{}, raw...)
		other[0] ^= 1
		if _, err := keys[f.Direction].Open(dir, f.Counter, other, ct); err == nil {
			t.Error("open with wrong device_id succeeded")
		}
	}
	if _, err := keys[0].Seal(DirC2D, MaxCounter+1, raw, nil); err == nil {
		t.Error("counter above limit accepted")
	}
}

func TestSPAKE2RoundTripRandom(t *testing.T) {
	w, err := CodeToW("K7M3-ABCD-EFGH")
	if err != nil {
		t.Fatal(err)
	}
	a, err := NewSPAKE2(SPAKE2RoleA, []byte(SPAKE2IdentityA), []byte(SPAKE2IdentityB), []byte(SPAKE2AAD), w)
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewSPAKE2(SPAKE2RoleB, []byte(SPAKE2IdentityA), []byte(SPAKE2IdentityB), []byte(SPAKE2AAD), w)
	if err != nil {
		t.Fatal(err)
	}
	ra, err := a.Finish(b.Message())
	if err != nil {
		t.Fatal(err)
	}
	rb, err := b.Finish(a.Message())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(ra.Ke, rb.Ke) {
		t.Fatal("Ke differs")
	}
	if !rb.VerifyCA(ra.CA) || !ra.VerifyCB(rb.CB) {
		t.Fatal("MACs do not verify")
	}
	if _, err := a.Finish(b.Message()); err != ErrFinished {
		t.Error("second Finish should fail")
	}
}

func TestSPAKE2WrongPassword(t *testing.T) {
	w1, _ := CodeToW("K7M3-ABCD-EFGH")
	w2, _ := CodeToW("K7M3-ABCD-EFGJ")
	a, err := NewSPAKE2(SPAKE2RoleA, []byte(SPAKE2IdentityA), []byte(SPAKE2IdentityB), []byte(SPAKE2AAD), w1)
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewSPAKE2(SPAKE2RoleB, []byte(SPAKE2IdentityA), []byte(SPAKE2IdentityB), []byte(SPAKE2AAD), w2)
	if err != nil {
		t.Fatal(err)
	}
	ra, err := a.Finish(b.Message())
	if err != nil {
		t.Fatal(err)
	}
	rb, err := b.Finish(a.Message())
	if err != nil {
		t.Fatal(err)
	}
	if rb.VerifyCA(ra.CA) {
		t.Error("cA verified with the wrong password")
	}
	if ra.VerifyCB(rb.CB) {
		t.Error("cB verified with the wrong password")
	}
	if bytes.Equal(ra.Ke, rb.Ke) {
		t.Error("Ke equal with different passwords")
	}
}

func TestSPAKE2RejectsBadPoints(t *testing.T) {
	w, _ := CodeToW("K7M3-ABCD-EFGH")
	fresh := func() *SPAKE2 {
		b, err := NewSPAKE2(SPAKE2RoleB, []byte(SPAKE2IdentityA), []byte(SPAKE2IdentityB), []byte(SPAKE2AAD), w)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	cases := map[string][]byte{
		"identity":     {0x00},
		"compressed":   unhex(t, spake2MHex),
		"short":        make([]byte, 64),
		"wrong prefix": append([]byte{0x05}, make([]byte, 64)...),
		"off-curve":    append([]byte{0x04}, make([]byte, 64)...),
	}
	for name, p := range cases {
		if _, err := fresh().Finish(p); err == nil {
			t.Errorf("%s point accepted", name)
		}
	}
}

func TestGenerateSecret(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		s, err := GenerateSecret()
		if err != nil {
			t.Fatal(err)
		}
		if len(s) != SecretLen {
			t.Fatalf("bad length %d", len(s))
		}
		if err := ValidateCode("K7M3" + s); err != nil {
			t.Fatalf("secret %q not valid: %v", s, err)
		}
		seen[s] = true
	}
	if len(seen) < 45 {
		t.Error("secrets are not random enough")
	}
}

func TestB64(t *testing.T) {
	b := []byte{0xfb, 0xff, 0x00, 1}
	s := B64(b)
	if s != "-_8AAQ" {
		t.Errorf("B64 = %q", s)
	}
	got, err := B64Decode(s)
	if err != nil || !bytes.Equal(got, b) {
		t.Errorf("B64Decode = %x, %v", got, err)
	}
	if _, err := B64Decode("-_8AAQ=="); err == nil {
		t.Error("padded input accepted")
	}
	if _, err := B64Decode("+/8A"); err == nil {
		t.Error("standard alphabet accepted")
	}
}
