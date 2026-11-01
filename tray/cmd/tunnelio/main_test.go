package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/config"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/crypto"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/ollama/ollamatest"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/relay/relaytest"
)

// lineWatcher captures stdout and lets the test wait for marker lines.
type lineWatcher struct {
	mu    sync.Mutex
	lines []string
	all   bytes.Buffer
	w     *io.PipeWriter
}

func newLineWatcher() *lineWatcher {
	r, w := io.Pipe()
	lw := &lineWatcher{w: w}
	go func() {
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			lw.mu.Lock()
			lw.lines = append(lw.lines, sc.Text())
			lw.all.WriteString(sc.Text() + "\n")
			lw.mu.Unlock()
		}
	}()
	return lw
}

func (lw *lineWatcher) wait(t *testing.T, re *regexp.Regexp, timeout time.Duration) []string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		lw.mu.Lock()
		for _, l := range lw.lines {
			if m := re.FindStringSubmatch(l); m != nil {
				lw.mu.Unlock()
				return m
			}
		}
		lw.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s\n--- output so far ---\n%s", re, lw.text())
	return nil
}

func (lw *lineWatcher) text() string {
	lw.mu.Lock()
	defer lw.mu.Unlock()
	return lw.all.String()
}

func TestParseArgsAndVersion(t *testing.T) {
	var out bytes.Buffer
	if err := run(context.Background(), []string{"--version"}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out.String(), "tunnelio ") {
		t.Errorf("version output = %q", out.String())
	}
	if _, err := parseArgs([]string{"--bogus"}, io.Discard); err == nil {
		t.Error("unknown flag accepted")
	}
	if _, err := parseArgs([]string{"extra"}, io.Discard); err == nil {
		t.Error("positional argument accepted")
	}
	t.Setenv("TUNNELIO_HEADLESS", "1")
	o, err := parseArgs(nil, io.Discard)
	if err != nil || !o.headless {
		t.Errorf("TUNNELIO_HEADLESS not honoured: %+v, %v", o, err)
	}
}

func TestHeadlessNoServer(t *testing.T) {
	t.Setenv("TUNNELIO_SERVER_URL", "")
	dir := t.TempDir()
	err := run(context.Background(), []string{"--headless", "--config-dir", dir, "--ollama", "http://127.0.0.1:1"}, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "server URL") {
		t.Fatalf("expected server URL error, got %v", err)
	}
}

// TestHeadlessEndToEnd runs the real program in headless mode against the fake relay and the
// fake Ollama: automatic pairing (code printed, browser joins, PAIRED), then a session with a
// full handshake and a list_models round trip. The captured stdout is logged.
func TestHeadlessEndToEnd(t *testing.T) {
	t.Setenv("TUNNELIO_SERVER_URL", "")
	t.Setenv("TUNNELIO_OLLAMA_URL", "")
	srv := relaytest.New("", "")
	defer srv.Close()
	oll := ollamatest.New()
	defer oll.Close()
	dir := t.TempDir()
	lw := newLineWatcher()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, []string{"--headless", "--config-dir", dir, "--server", srv.URL, "--ollama", oll.URL}, lw.w, io.Discard)
	}()
	defer func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("run returned %v", err)
			}
		case <-time.After(10 * time.Second):
			t.Error("run did not stop after cancel")
		}
		_ = lw.w.Close()
		t.Logf("--- headless stdout ---\n%s", lw.text())
	}()

	lw.wait(t, regexp.MustCompile(`^RELAY connected$`), 10*time.Second)
	m := lw.wait(t, regexp.MustCompile(`^PAIRING CODE: ([0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4})$`), 10*time.Second)
	code := m[1]

	// Fake browser: SPAKE2 role A with the printed code.
	norm := crypto.NormalizeCode(code)
	br, ok := srv.Join(norm[:crypto.ClaimLen])
	if !ok {
		t.Fatalf("join with claim %q failed", norm[:4])
	}
	w, err := crypto.CodeToW(code)
	if err != nil {
		t.Fatal(err)
	}
	sp, err := crypto.NewSPAKE2(crypto.SPAKE2RoleA, []byte(crypto.SPAKE2IdentityA), []byte(crypto.SPAKE2IdentityB), []byte(crypto.SPAKE2AAD), w)
	if err != nil {
		t.Fatal(err)
	}
	br.SendPairMsg(srv, map[string]any{"t": "pake1", "v": 1, "pA": crypto.B64(sp.Message())})
	p2raw, ok := br.NextPairMsg(5 * time.Second)
	if !ok {
		t.Fatal("no pake2")
	}
	var p2 struct {
		T  string `json:"t"`
		PB string `json:"pB"`
		CB string `json:"cB"`
	}
	if err := json.Unmarshal(p2raw, &p2); err != nil || p2.T != "pake2" {
		t.Fatalf("pake2 = %s", p2raw)
	}
	pB, _ := crypto.B64Decode(p2.PB)
	cB, _ := crypto.B64Decode(p2.CB)
	res, err := sp.Finish(pB)
	if err != nil {
		t.Fatal(err)
	}
	if !res.VerifyCB(cB) {
		t.Fatal("cB mismatch")
	}
	br.SendPairMsg(srv, map[string]any{"t": "pake3", "v": 1, "cA": crypto.B64(res.CA)})
	if r, ok := br.Result(5 * time.Second); !ok || !r.Bool("ok") {
		t.Fatalf("pair_done = %+v", r)
	}
	m = lw.wait(t, regexp.MustCompile(`^PAIRED device_id=([0-9a-f-]{36})$`), 10*time.Second)
	deviceID := m[1]
	if did, _ := srv.Device(); did != deviceID {
		t.Errorf("printed device_id %s != relay %s", deviceID, did)
	}
	lw.wait(t, regexp.MustCompile(`^PAIRING OK$`), 5*time.Second)

	// Files persisted with the right modes.
	paths := config.NewPaths(dir)
	dev, err := config.LoadDevice(paths)
	if err != nil || dev == nil || dev.DeviceID != deviceID {
		t.Fatalf("device.json = %+v, %v", dev, err)
	}
	if runtime.GOOS != "windows" {
		for _, f := range []string{paths.DeviceFile, paths.PairingsFile} {
			st, err := os.Stat(f)
			if err != nil || st.Mode().Perm() != 0o600 {
				t.Errorf("%s mode = %v, %v", filepath.Base(f), st.Mode(), err)
			}
		}
	}
	ps, _ := config.LoadPairings(paths)
	pk := crypto.PairingKey(res.Ke)
	pid := crypto.PairingID(pk)
	if got, ok := ps.Lookup(pid); !ok || !bytes.Equal(got, pk) {
		t.Fatal("pairings.json does not contain the browser's PK")
	}

	// Session: handshake + list_models through the encrypted channel.
	sess := srv.OpenSession("c1")
	lw.wait(t, regexp.MustCompile(`^SESSION c1 opened$`), 5*time.Second)
	eph, _ := crypto.NewEphemeral()
	srv.SendData("c1", map[string]any{"v": 1, "hs": "hello", "pairing_id": crypto.B64(pid), "eph_pub": crypto.B64(eph.PublicKey().Bytes())})
	ackRaw, ok := sess.Next(5 * time.Second)
	if !ok {
		t.Fatal("no hello_ack")
	}
	var ack struct {
		HS     string `json:"hs"`
		EphPub string `json:"eph_pub"`
		MAC    string `json:"mac"`
	}
	if err := json.Unmarshal(ackRaw, &ack); err != nil || ack.HS != "hello_ack" {
		t.Fatalf("hello_ack = %s", ackRaw)
	}
	pubD, _ := crypto.B64Decode(ack.EphPub)
	macD, _ := crypto.B64Decode(ack.MAC)
	keys, err := crypto.DeriveSessionKeysClient(pk, pid, eph, pubD)
	if err != nil {
		t.Fatal(err)
	}
	if !crypto.VerifyMAC(macD, keys.MACD) {
		t.Fatal("mac_d mismatch")
	}
	srv.SendData("c1", map[string]any{"v": 1, "hs": "confirm", "mac": crypto.B64(keys.MACC)})
	lw.wait(t, regexp.MustCompile(`^SESSION c1 handshake ok$`), 5*time.Second)

	devRaw, _ := crypto.ParseDeviceID(deviceID)
	recvKey, _ := crypto.NewEnvelopeKey(keys.D2C)
	sendKey, _ := crypto.NewEnvelopeKey(keys.C2D)
	var recvCtr uint64
	open := func() map[string]any {
		raw, ok := sess.Next(5 * time.Second)
		if !ok {
			t.Fatal("no envelope")
		}
		var env struct {
			V          int    `json:"v"`
			DeviceID   string `json:"device_id"`
			Nonce      string `json:"nonce"`
			Ciphertext string `json:"ciphertext"`
		}
		if err := json.Unmarshal(raw, &env); err != nil || env.V != 1 || env.DeviceID != deviceID {
			t.Fatalf("envelope = %s", raw)
		}
		nonce, _ := crypto.B64Decode(env.Nonce)
		if nonce[0] != crypto.DirD2C || binary.BigEndian.Uint64(nonce[4:]) != recvCtr {
			t.Fatalf("nonce = %x", nonce)
		}
		ct, _ := crypto.B64Decode(env.Ciphertext)
		pt, err := recvKey.Open(crypto.DirD2C, recvCtr, devRaw, ct)
		if err != nil {
			t.Fatal(err)
		}
		recvCtr++
		var msg map[string]any
		_ = json.Unmarshal(pt, &msg)
		return msg
	}
	info := open()
	if info["type"] != "device_info" || info["platform"] != platform() {
		t.Fatalf("device_info = %v", info)
	}
	if ol, _ := info["ollama"].(map[string]any); ol["status"] != "running" || ol["version"] != "0.0.0-fake" {
		t.Errorf("device_info.ollama = %v", info["ollama"])
	}
	req, _ := json.Marshal(map[string]any{"type": "list_models", "id": "r1"})
	ct, _ := sendKey.Seal(crypto.DirC2D, 0, devRaw, req)
	srv.SendData("c1", map[string]any{"v": 1, "device_id": deviceID, "nonce": crypto.B64(crypto.EnvelopeNonce(crypto.DirC2D, 0)), "ciphertext": crypto.B64(ct)})
	models := open()
	if models["type"] != "models" || models["id"] != "r1" {
		t.Fatalf("models = %v", models)
	}
	if list := models["models"].([]any); len(list) != 1 || list[0].(map[string]any)["name"] != "fake:latest" {
		t.Errorf("models = %v", models["models"])
	}
	srv.CloseSession("c1", "client")
	lw.wait(t, regexp.MustCompile(`^SESSION c1 closed reason=client$`), 5*time.Second)
}
