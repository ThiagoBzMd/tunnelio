package relay_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/relay"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/relay/relaytest"
)

func TestDeviceURL(t *testing.T) {
	cases := map[string]string{
		"http://localhost:8080":      "ws://localhost:8080/ws/device",
		"https://app.example/":       "wss://app.example/ws/device",
		"https://app.example/base/":  "wss://app.example/base/ws/device",
		"wss://app.example?x=1#frag": "wss://app.example/ws/device",
	}
	for in, want := range cases {
		got, err := relay.DeviceURL(in)
		if err != nil || got != want {
			t.Errorf("DeviceURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "ftp://x", "/relative", "http://"} {
		if _, err := relay.DeviceURL(bad); err == nil {
			t.Errorf("DeviceURL(%q) accepted", bad)
		}
	}
}

type recorder struct {
	mu        sync.Mutex
	events    []string
	connected chan relay.Welcome
	data      chan [2]string
	unauth    chan struct{}
	replaced  chan struct{}
	disc      chan int
}

func newRecorder() *recorder {
	return &recorder{connected: make(chan relay.Welcome, 8), data: make(chan [2]string, 8),
		unauth: make(chan struct{}, 8), replaced: make(chan struct{}, 8), disc: make(chan int, 8)}
}

func (r *recorder) add(e string) {
	r.mu.Lock()
	r.events = append(r.events, e)
	r.mu.Unlock()
}

func (r *recorder) handlers() relay.Handlers {
	return relay.Handlers{
		OnConnected:     func(w relay.Welcome) { r.add("connected"); r.connected <- w },
		OnDisconnected:  func(code int, _ error) { r.add("disconnected"); r.disc <- code },
		OnPairReady:     func(claim, _ string) { r.add("pair_ready:" + claim) },
		OnPairJoined:    func() { r.add("pair_joined") },
		OnPairMsg:       func(p json.RawMessage) { r.add("pair_msg:" + string(p)) },
		OnPaired:        func(id, tok string) { r.add("paired:" + id) },
		OnPairAborted:   func(reason string) { r.add("pair_aborted:" + reason) },
		OnSessionOpen:   func(cid string) { r.add("session_open:" + cid) },
		OnSessionClosed: func(cid, reason string) { r.add("session_closed:" + cid + ":" + reason) },
		OnData:          func(cid, did string, p json.RawMessage) { r.add("data"); r.data <- [2]string{cid, string(p)} },
		OnRevoked:       func(reason string) { r.add("revoked:" + reason) },
		OnUnauthorized:  func() { r.add("unauthorized"); r.unauth <- struct{}{} },
		OnReplaced:      func() { r.add("replaced"); r.replaced <- struct{}{} },
		OnError:         func(code, _ string) { r.add("error:" + code) },
	}
}

func (r *recorder) has(e string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, x := range r.events {
		if x == e {
			return true
		}
	}
	return false
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

func startClient(t *testing.T, srv *relaytest.Server, token string, rec *recorder) (*relay.Client, context.CancelFunc) {
	t.Helper()
	tok := token
	c, err := relay.New(relay.Config{
		ServerURL:    srv.URL,
		Token:        func() string { return tok },
		Version:      "test",
		Platform:     "linux",
		Logger:       slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Handlers:     rec.handlers(),
		PingInterval: 50 * time.Millisecond,
		PongTimeout:  300 * time.Millisecond,
		BackoffBase:  20 * time.Millisecond,
		BackoffMax:   100 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = c.Run(ctx) }()
	return c, cancel
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) { w.t.Log(string(p)); return len(p), nil }

func TestHelloWelcomeAndFrames(t *testing.T) {
	srv := relaytest.New("", "")
	defer srv.Close()
	rec := newRecorder()
	c, cancel := startClient(t, srv, "", rec)
	defer cancel()

	w := <-rec.connected
	if w.V != 1 || w.DeviceID != nil || w.Limits.MaxFrameBytes != 1<<20 {
		t.Errorf("welcome = %+v", w)
	}
	if h := srv.LastHeaders(); h.Get("Authorization") != "" {
		t.Error("unpaired client sent Authorization header")
	}
	hello, ok := srv.WaitFrame("hello", time.Second)
	if !ok || hello.String("app") != "tray" || hello.String("platform") != "linux" {
		t.Errorf("hello = %+v", hello)
	}
	st, _ := c.State()
	if st != relay.StateConnected {
		t.Errorf("state = %v", st)
	}

	// Pairing frames round-trip.
	if err := c.SendPairStart(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "pair_ready", func() bool { return rec.has("pair_ready:0001") })
	b, ok := srv.Join("0001")
	if !ok {
		t.Fatal("join failed")
	}
	waitFor(t, "pair_joined", func() bool { return rec.has("pair_joined") })
	b.SendPairMsg(srv, map[string]any{"t": "pake1"})
	waitFor(t, "pair_msg", func() bool { return rec.has(`pair_msg:{"t":"pake1"}`) })
	if err := c.SendPairMsg(json.RawMessage(`{"t":"pake2"}`)); err != nil {
		t.Fatal(err)
	}
	if p, ok := b.NextPairMsg(time.Second); !ok || string(p) != `{"t":"pake2"}` {
		t.Errorf("browser got %s", p)
	}
	if err := c.SendPairDone(true, "my-pc"); err != nil {
		t.Fatal(err)
	}
	res, ok := b.Result(time.Second)
	if !ok || !res.Bool("ok") || res.String("name") != "my-pc" {
		t.Errorf("pair_done = %+v", res)
	}
	did, tok := srv.Device()
	waitFor(t, "paired", func() bool { return rec.has("paired:" + did) })
	if tok == "" {
		t.Fatal("no token issued")
	}
	if _, id := c.State(); id != did {
		t.Errorf("device id after paired = %q", id)
	}

	// Sessions and data.
	sess := srv.OpenSession("c1")
	waitFor(t, "session_open", func() bool { return rec.has("session_open:c1") })
	srv.SendData("c1", map[string]any{"hs": "hello"})
	d := <-rec.data
	if d[0] != "c1" || d[1] != `{"hs":"hello"}` {
		t.Errorf("data = %v", d)
	}
	if err := c.SendData("c1", json.RawMessage(`{"x":1}`)); err != nil {
		t.Fatal(err)
	}
	if p, ok := sess.Next(time.Second); !ok || string(p) != `{"x":1}` {
		t.Errorf("session got %s", p)
	}
	if err := c.SendClose("c1"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "session_closed", func() bool { return rec.has("session_closed:c1:device") })
	srv.AbortPairing("expired")
	waitFor(t, "pair_aborted", func() bool { return rec.has("pair_aborted:expired") })

	// Keepalive: pings flow and pongs come back.
	if _, ok := srv.WaitFrame("ping", time.Second); !ok {
		t.Error("no ping received")
	}
	if err := c.SendData("c1", json.RawMessage(`"`+strings.Repeat("a", 2<<20)+`"`)); err != relay.ErrFrameTooLarge {
		t.Errorf("oversize frame: %v", err)
	}
}

func TestTokenAndCloseCodes(t *testing.T) {
	srv := relaytest.New("dev-1", "tok-1")
	defer srv.Close()
	rec := newRecorder()
	c, cancel := startClient(t, srv, "tok-1", rec)
	defer cancel()
	w := <-rec.connected
	if w.DeviceID == nil || *w.DeviceID != "dev-1" {
		t.Fatalf("welcome = %+v", w)
	}
	if h := srv.LastHeaders(); h.Get("Authorization") != "Bearer tok-1" {
		t.Errorf("Authorization = %q", h.Get("Authorization"))
	}

	// 4005: reconnect with backoff.
	srv.CloseDevice(4005, "shutdown")
	if code := <-rec.disc; code != 4005 {
		t.Errorf("close code = %d", code)
	}
	<-rec.connected

	// 4006: replaced → OnReplaced, reconnect after max backoff.
	srv.CloseDevice(4006, "replaced")
	<-rec.replaced
	<-rec.connected

	// revoked + 4001 → OnUnauthorized.
	srv.Revoke("deleted")
	<-rec.unauth
	waitFor(t, "revoked", func() bool { return rec.has("revoked:deleted") })
	_ = c
}

func TestDeadConnectionDetection(t *testing.T) {
	srv := relaytest.New("", "")
	defer srv.Close()
	rec := newRecorder()
	_, cancel := startClient(t, srv, "", rec)
	defer cancel()
	<-rec.connected
	// Stop answering pings: the client must drop the connection and reconnect.
	srv.MutePongs(true)
	code := <-rec.disc
	t.Logf("disconnected with code %d after pong timeout", code)
	srv.MutePongs(false)
	<-rec.connected
}
