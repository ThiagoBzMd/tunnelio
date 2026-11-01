package pairing_test

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/config"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/crypto"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/pairing"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/relay"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/relay/relaytest"
)

type harness struct {
	srv      *relaytest.Server
	client   *relay.Client
	pairer   *pairing.Pairer
	pairings *config.Pairings
	codes    chan string
	results  chan result
	paired   chan [2]string
	cancel   context.CancelFunc
}

type result struct {
	ok  bool
	err error
}

func newHarness(t *testing.T, timeout time.Duration) *harness {
	t.Helper()
	h := &harness{
		srv:     relaytest.New("", ""),
		codes:   make(chan string, 4),
		results: make(chan result, 4),
		paired:  make(chan [2]string, 4),
	}
	t.Cleanup(h.srv.Close)
	ps, err := config.LoadPairings(config.NewPaths(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	h.pairings = ps
	var mu sync.Mutex
	token := ""
	logger := slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelDebug}))
	connected := make(chan struct{}, 4)
	c, err := relay.New(relay.Config{
		ServerURL: h.srv.URL,
		Token: func() string {
			mu.Lock()
			defer mu.Unlock()
			return token
		},
		Version: "test", Platform: "linux", Logger: logger,
		BackoffBase: 10 * time.Millisecond, BackoffMax: 50 * time.Millisecond,
		Handlers: relay.Handlers{
			OnConnected:    func(relay.Welcome) { connected <- struct{}{} },
			OnPairReady:    func(claim, exp string) { h.pairer.HandlePairReady(claim, exp) },
			OnPairJoined:   func() { h.pairer.HandlePairJoined() },
			OnPairMsg:      func(p json.RawMessage) { h.pairer.HandlePairMsg(p) },
			OnPaired:       func(id, tok string) { h.pairer.HandlePaired(id, tok) },
			OnPairAborted:  func(r string) { h.pairer.HandlePairAborted(r) },
			OnDisconnected: func(int, error) { h.pairer.HandleDisconnected() },
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	h.client = c
	h.pairer = pairing.New(pairing.Config{
		Transport: c, Store: ps, DeviceName: "test-pc", Logger: logger, Timeout: timeout,
		OnCode:   func(code string) { h.codes <- code },
		OnResult: func(ok bool, err error) { h.results <- result{ok, err} },
		OnPaired: func(id, tok string) {
			mu.Lock()
			token = tok
			mu.Unlock()
			h.paired <- [2]string{id, tok}
		},
	})
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	t.Cleanup(cancel)
	go func() { _ = c.Run(ctx) }()
	select {
	case <-connected:
	case <-time.After(5 * time.Second):
		t.Fatal("relay did not connect")
	}
	return h
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) { w.t.Log(string(p)); return len(p), nil }

// browser is the fake client side (A) of the SPAKE2 exchange.
type browser struct {
	t  *testing.T
	b  *relaytest.Browser
	sp *crypto.SPAKE2
}

func joinWithCode(t *testing.T, h *harness, code string) *browser {
	t.Helper()
	norm := crypto.NormalizeCode(code)
	claim := norm[:crypto.ClaimLen]
	b, ok := h.srv.Join(claim)
	if !ok {
		t.Fatalf("join %q failed", claim)
	}
	w, err := crypto.CodeToW(code)
	if err != nil {
		t.Fatal(err)
	}
	sp, err := crypto.NewSPAKE2(crypto.SPAKE2RoleA, []byte(crypto.SPAKE2IdentityA), []byte(crypto.SPAKE2IdentityB), []byte(crypto.SPAKE2AAD), w)
	if err != nil {
		t.Fatal(err)
	}
	return &browser{t: t, b: b, sp: sp}
}

func (br *browser) sendPake1(h *harness) {
	br.b.SendPairMsg(h.srv, map[string]any{"t": "pake1", "v": 1, "pA": crypto.B64(br.sp.Message())})
}

func (br *browser) recvPake2() (pB, cB []byte) {
	p, ok := br.b.NextPairMsg(3 * time.Second)
	if !ok {
		br.t.Fatal("no pake2")
	}
	var m struct {
		T  string `json:"t"`
		V  int    `json:"v"`
		PB string `json:"pB"`
		CB string `json:"cB"`
	}
	if err := json.Unmarshal(p, &m); err != nil || m.T != "pake2" || m.V != 1 {
		br.t.Fatalf("bad pake2: %s", p)
	}
	pB, _ = crypto.B64Decode(m.PB)
	cB, _ = crypto.B64Decode(m.CB)
	return pB, cB
}

func TestPairingHappyPath(t *testing.T) {
	h := newHarness(t, 5*time.Second)
	if err := h.pairer.Start(); err != nil {
		t.Fatal(err)
	}
	if err := h.pairer.Start(); !errors.Is(err, pairing.ErrBusy) {
		t.Errorf("second Start = %v", err)
	}
	code := <-h.codes
	if len(code) != 14 || crypto.ValidateCode(crypto.NormalizeCode(code)) != nil {
		t.Fatalf("bad code %q", code)
	}
	br := joinWithCode(t, h, code)
	br.sendPake1(h)
	pB, cB := br.recvPake2()
	res, err := br.sp.Finish(pB)
	if err != nil {
		t.Fatal(err)
	}
	if !res.VerifyCB(cB) {
		t.Fatal("cB does not verify on the browser side")
	}
	br.b.SendPairMsg(h.srv, map[string]any{"t": "pake3", "v": 1, "cA": crypto.B64(res.CA)})

	done, ok := br.b.Result(3 * time.Second)
	if !ok || !done.Bool("ok") || done.String("name") != "test-pc" {
		t.Fatalf("pair_done = %+v", done)
	}
	r := <-h.results
	if !r.ok || r.err != nil {
		t.Fatalf("result = %+v", r)
	}
	// Pairing persisted with the same PK/pairing_id the browser derives.
	pk := crypto.PairingKey(res.Ke)
	pid := crypto.PairingID(pk)
	got, found := h.pairings.Lookup(pid)
	if !found || string(got) != string(pk) {
		t.Fatal("pairing not stored or PK mismatch")
	}
	// First pairing: the relay issues device_id + token.
	select {
	case p := <-h.paired:
		did, tok := h.srv.Device()
		if p[0] != did || p[1] != tok {
			t.Errorf("paired = %v, server has %s", p, did)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no paired callback")
	}
	if h.pairer.Active() {
		t.Error("pairer still active")
	}
	// Second pairing with the same device: no new paired frame, new pairing stored.
	if err := h.pairer.Start(); err != nil {
		t.Fatal(err)
	}
	code2 := <-h.codes
	br2 := joinWithCode(t, h, code2)
	br2.sendPake1(h)
	pB2, _ := br2.recvPake2()
	res2, _ := br2.sp.Finish(pB2)
	br2.b.SendPairMsg(h.srv, map[string]any{"t": "pake3", "v": 1, "cA": crypto.B64(res2.CA)})
	if r := <-h.results; !r.ok {
		t.Fatalf("second pairing failed: %v", r.err)
	}
	if h.pairings.Count() != 2 {
		t.Errorf("pairings = %d", h.pairings.Count())
	}
	select {
	case <-h.paired:
		t.Error("paired issued twice")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestPairingWrongCode(t *testing.T) {
	h := newHarness(t, 5*time.Second)
	if err := h.pairer.Start(); err != nil {
		t.Fatal(err)
	}
	code := <-h.codes
	norm := crypto.NormalizeCode(code)
	// Same claim, wrong secret (flip the last symbol).
	last := norm[len(norm)-1]
	repl := byte('A')
	if last == 'A' {
		repl = 'B'
	}
	wrong := norm[:len(norm)-1] + string(repl)
	br := joinWithCode(t, h, wrong)
	br.sendPake1(h)
	pB, cB := br.recvPake2()
	res, err := br.sp.Finish(pB)
	if err != nil {
		t.Fatal(err)
	}
	if res.VerifyCB(cB) {
		t.Fatal("cB verified with a wrong code")
	}
	// A browser that ignores the mismatch and sends its cA anyway must be rejected.
	br.b.SendPairMsg(h.srv, map[string]any{"t": "pake3", "v": 1, "cA": crypto.B64(res.CA)})
	done, ok := br.b.Result(3 * time.Second)
	if !ok || done.Bool("ok") {
		t.Fatalf("pair_done = %+v", done)
	}
	r := <-h.results
	if r.ok || !errors.Is(r.err, pairing.ErrBadMAC) {
		t.Fatalf("result = %+v", r)
	}
	if h.pairings.Count() != 0 {
		t.Error("pairing stored despite MAC failure")
	}
	// The code is invalidated: a second join on the same claim fails (new Start needed).
	if h.pairer.Active() {
		t.Error("pairer still active after failure")
	}
}

func TestPairingTimeoutAndMalformed(t *testing.T) {
	h := newHarness(t, 150*time.Millisecond)
	if err := h.pairer.Start(); err != nil {
		t.Fatal(err)
	}
	code := <-h.codes
	br := joinWithCode(t, h, code)
	_ = br
	// No pake1 arrives: timeout → pair_done{ok:false}.
	done, ok := br.b.Result(3 * time.Second)
	if !ok || done.Bool("ok") {
		t.Fatalf("pair_done = %+v", done)
	}
	if r := <-h.results; r.ok || !errors.Is(r.err, pairing.ErrTimeout) {
		t.Fatalf("result = %+v", r)
	}

	// Malformed pake1.
	if err := h.pairer.Start(); err != nil {
		t.Fatal(err)
	}
	code = <-h.codes
	br = joinWithCode(t, h, code)
	br.b.SendPairMsg(h.srv, map[string]any{"t": "pake1", "v": 1, "pA": "not-a-point"})
	if done, ok := br.b.Result(3 * time.Second); !ok || done.Bool("ok") {
		t.Fatalf("pair_done = %+v", done)
	}
	if r := <-h.results; r.ok {
		t.Fatal("malformed pake1 accepted")
	}

	// pair_aborted from the relay.
	if err := h.pairer.Start(); err != nil {
		t.Fatal(err)
	}
	<-h.codes
	h.srv.AbortPairing("expired")
	if r := <-h.results; r.ok || !errors.Is(r.err, pairing.ErrAborted) {
		t.Fatalf("result = %+v", r)
	}
}
