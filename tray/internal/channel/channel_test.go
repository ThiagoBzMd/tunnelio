package channel_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/channel"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/config"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/crypto"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/history"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/ollama"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/ollama/ollamatest"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/relay"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/relay/relaytest"
)

const wait = 3 * time.Second

type vectors struct {
	V3 struct {
		PK        string `json:"PK"`
		PairingID string `json:"pairing_id"`
	} `json:"V3_pairing_key"`
	V5 struct {
		DeviceID string `json:"device_id"`
	} `json:"V5_envelope"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean("../../../docs/vectors/vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

type notes struct {
	mu   sync.Mutex
	list []string
}

func (n *notes) Notify(title, body string) {
	n.mu.Lock()
	n.list = append(n.list, title+": "+body)
	n.mu.Unlock()
}

func (n *notes) all() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string(nil), n.list...)
}

type harness struct {
	t        *testing.T
	relay    *relaytest.Server
	ollama   *ollamatest.Server
	history  *history.Store
	manager  *channel.Manager
	notes    *notes
	pk, pid  []byte
	devRaw   []byte
	deviceID string
}

type harnessOpts struct {
	burst         int
	maxFrameBytes int
}

func newHarness(t *testing.T, o harnessOpts) *harness {
	t.Helper()
	v := loadVectors(t)
	h := &harness{t: t, notes: &notes{}, deviceID: v.V5.DeviceID}
	h.pk, _ = hex.DecodeString(v.V3.PK)
	h.pid, _ = hex.DecodeString(v.V3.PairingID)
	h.devRaw, _ = crypto.ParseDeviceID(h.deviceID)

	h.ollama = ollamatest.New()
	t.Cleanup(h.ollama.Close)
	oc, err := ollama.New(h.ollama.URL, ollama.Options{})
	if err != nil {
		t.Fatal(err)
	}
	h.history, err = history.Open(filepath.Join(t.TempDir(), "h.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.history.Close() })
	ps, _ := config.LoadPairings(config.NewPaths(t.TempDir()))
	if err := ps.Add(h.pid, h.pk, "vector browser"); err != nil {
		t.Fatal(err)
	}

	h.relay = relaytest.New(h.deviceID, "tok")
	if o.maxFrameBytes > 0 {
		h.relay.MaxFrameBytes = o.maxFrameBytes
	}
	t.Cleanup(h.relay.Close)
	logger := slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelDebug}))
	connected := make(chan struct{}, 4)
	rc, err := relay.New(relay.Config{
		ServerURL: h.relay.URL, Token: func() string { return "tok" }, Version: "test", Platform: "linux", Logger: logger,
		BackoffBase: 10 * time.Millisecond, BackoffMax: 50 * time.Millisecond,
		Handlers: relay.Handlers{
			OnConnected:     func(relay.Welcome) { connected <- struct{}{} },
			OnDisconnected:  func(int, error) { h.manager.OnDisconnected() },
			OnSessionOpen:   func(cid string) { h.manager.OnSessionOpen(cid) },
			OnSessionClosed: func(cid, r string) { h.manager.OnSessionClosed(cid, r) },
			OnData:          func(cid, did string, p json.RawMessage) { h.manager.OnData(cid, did, p) },
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	h.manager = channel.New(channel.Config{
		Transport: rc, Pairings: ps, Ollama: oc, History: h.history, Notifier: h.notes, Logger: logger,
		TrayVersion: "test", Platform: "linux",
		OllamaStatus:  func() channel.OllamaStatus { return channel.OllamaStatus{Status: "running", Version: "0.0.0-fake"} },
		ChunkInterval: 20 * time.Millisecond, PullInterval: 30 * time.Millisecond, RequestBurst: o.burst,
	})
	if err := h.manager.SetDeviceID(h.deviceID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = rc.Run(ctx) }()
	select {
	case <-connected:
	case <-time.After(wait):
		t.Fatal("relay did not connect")
	}
	return h
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Log(strings.TrimSpace(string(p)))
	return len(p), nil
}

// browser is the fake client side of one session.
type browser struct {
	h       *harness
	id      string
	sess    *relaytest.Session
	sendKey *crypto.EnvelopeKey
	recvKey *crypto.EnvelopeKey
	sendCtr uint64
	recvCtr uint64
	// lastSize is the plaintext length of the last envelope opened by tryRecv.
	lastSize int
}

func (h *harness) open(clientID string) *browser {
	b := &browser{h: h, id: clientID, sess: h.relay.OpenSession(clientID)}
	deadline := time.Now().Add(wait)
	for h.manager.Sessions() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	return b
}

func (b *browser) sendRaw(v any) { b.h.relay.SendData(b.id, v) }

// nextRaw returns the next payload as a generic map (handshake or envelope).
func (b *browser) nextRaw(timeout time.Duration) (map[string]any, bool) {
	p, ok := b.sess.Next(timeout)
	if !ok {
		return nil, false
	}
	var m map[string]any
	if err := json.Unmarshal(p, &m); err != nil {
		b.h.t.Fatalf("bad payload %s", p)
	}
	return m, true
}

// handshake runs hello → hello_ack → confirm and returns the first envelope (device_info).
func (b *browser) handshake(expectOK bool) map[string]any {
	t := b.h.t
	t.Helper()
	eph, _ := crypto.NewEphemeral()
	b.sendRaw(map[string]any{"v": 1, "hs": "hello", "pairing_id": crypto.B64(b.h.pid), "eph_pub": crypto.B64(eph.PublicKey().Bytes())})
	ack, ok := b.nextRaw(wait)
	if !ok {
		t.Fatal("no hello_ack")
	}
	if !expectOK {
		return ack
	}
	if ack["hs"] != "hello_ack" {
		t.Fatalf("expected hello_ack, got %v", ack)
	}
	pubD, _ := crypto.B64Decode(ack["eph_pub"].(string))
	macD, _ := crypto.B64Decode(ack["mac"].(string))
	keys, err := crypto.DeriveSessionKeysClient(b.h.pk, b.h.pid, eph, pubD)
	if err != nil {
		t.Fatal(err)
	}
	if !crypto.VerifyMAC(macD, keys.MACD) {
		t.Fatal("mac_d does not verify")
	}
	b.sendKey, _ = crypto.NewEnvelopeKey(keys.C2D)
	b.recvKey, _ = crypto.NewEnvelopeKey(keys.D2C)
	b.sendCtr, b.recvCtr = 0, 0
	b.sendRaw(map[string]any{"v": 1, "hs": "confirm", "mac": crypto.B64(keys.MACC)})
	info := b.recv(wait)
	if info["type"] != "device_info" {
		t.Fatalf("first envelope is not device_info: %v", info)
	}
	return info
}

func (b *browser) seal(v any) map[string]any {
	plaintext, _ := json.Marshal(v)
	ct, err := b.sendKey.Seal(crypto.DirC2D, b.sendCtr, b.h.devRaw, plaintext)
	if err != nil {
		b.h.t.Fatal(err)
	}
	env := map[string]any{"v": 1, "device_id": b.h.deviceID, "nonce": crypto.B64(crypto.EnvelopeNonce(crypto.DirC2D, b.sendCtr)), "ciphertext": crypto.B64(ct)}
	b.sendCtr++
	return env
}

func (b *browser) send(v any) { b.sendRaw(b.seal(v)) }

// recv opens the next envelope (fails the test on timeout).
func (b *browser) recv(timeout time.Duration) map[string]any {
	b.h.t.Helper()
	m, ok := b.tryRecv(timeout)
	if !ok {
		b.h.t.Fatal("timeout waiting for envelope")
	}
	return m
}

func (b *browser) tryRecv(timeout time.Duration) (map[string]any, bool) {
	raw, ok := b.nextRaw(timeout)
	if !ok {
		return nil, false
	}
	if raw["ciphertext"] == nil {
		b.h.t.Fatalf("expected envelope, got %v", raw)
	}
	nonce, _ := crypto.B64Decode(raw["nonce"].(string))
	if nonce[0] != crypto.DirD2C || binary.BigEndian.Uint64(nonce[4:]) != b.recvCtr {
		b.h.t.Fatalf("unexpected nonce %x (want counter %d)", nonce, b.recvCtr)
	}
	ct, _ := crypto.B64Decode(raw["ciphertext"].(string))
	pt, err := b.recvKey.Open(crypto.DirD2C, b.recvCtr, b.h.devRaw, ct)
	if err != nil {
		b.h.t.Fatalf("open: %v", err)
	}
	b.recvCtr++
	b.lastSize = len(pt)
	var m map[string]any
	if err := json.Unmarshal(pt, &m); err != nil {
		b.h.t.Fatal(err)
	}
	return m, true
}

// recvSized is recv plus the plaintext size of the envelope.
func (b *browser) recvSized(timeout time.Duration) (map[string]any, int) {
	b.h.t.Helper()
	m := b.recv(timeout)
	return m, b.lastSize
}

// recvType reads envelopes until one of the given type arrives.
func (b *browser) recvType(typ string) map[string]any {
	b.h.t.Helper()
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		m := b.recv(wait)
		if m["type"] == typ {
			return m
		}
	}
	b.h.t.Fatalf("no %s", typ)
	return nil
}

func TestHandshakeAndModels(t *testing.T) {
	h := newHarness(t, harnessOpts{burst: 100})
	b := h.open("c1")
	info := b.handshake(true)
	if info["tray_version"] != "test" || info["platform"] != "linux" {
		t.Errorf("device_info = %v", info)
	}
	if ol, _ := info["ollama"].(map[string]any); ol["status"] != "running" || ol["version"] != "0.0.0-fake" {
		t.Errorf("device_info.ollama = %v", info["ollama"])
	}
	if lim, _ := info["limits"].(map[string]any); lim["max_message_bytes"] != float64(8<<20) || lim["chat_concurrency"] != float64(1) ||
		lim["pull_concurrency"] != float64(1) || lim["max_images_per_message"] != float64(4) || lim["max_image_bytes"] != float64(4<<20) {
		t.Errorf("device_info.limits = %v", info["limits"])
	}
	if caps := fmt.Sprint(info["capabilities"]); caps != "[history think images history_clear incognito agents chain]" {
		t.Errorf("device_info.capabilities = %v", info["capabilities"])
	}

	b.send(map[string]any{"type": "list_models", "id": "r1"})
	m := b.recv(wait)
	if m["type"] != "models" || m["id"] != "r1" {
		t.Fatalf("models = %v", m)
	}
	models := m["models"].([]any)
	if len(models) != 1 || models[0].(map[string]any)["name"] != "fake:latest" {
		t.Errorf("models = %v", models)
	}
	det := models[0].(map[string]any)["details"].(map[string]any)
	if det["family"] != "fake" || det["parameter_size"] != "0.5B" || det["quantization_level"] != "Q4_0" || det["format"] != "gguf" {
		t.Errorf("details = %v", det)
	}

	h.ollama.Running = []map[string]any{{"name": "fake:latest", "size": 1, "size_vram": 1, "expires_at": "2026-01-01T00:00:00Z", "context_length": 32768}}
	b.send(map[string]any{"type": "list_running", "id": "r2"})
	if m := b.recv(wait); m["type"] != "running" || m["id"] != "r2" || m["models"].([]any)[0].(map[string]any)["context_length"] != float64(32768) {
		t.Errorf("running = %v", m)
	}
	h.ollama.Running = nil
	b.send(map[string]any{"type": "show_model", "id": "r3", "name": "fake:latest"})
	m = b.recv(wait)
	if m["type"] != "model_info" || m["name"] != "fake:latest" || m["context_length"] != float64(32768) || len(m["license"].(string)) != 4096 {
		t.Errorf("model_info = %v", m)
	}
	b.send(map[string]any{"type": "show_model", "id": "r4", "name": "Bad Name"})
	if m := b.recv(wait); m["type"] != "error" || m["code"] != "E_BAD_MODEL_NAME" || m["id"] != "r4" {
		t.Errorf("bad name = %v", m)
	}
	b.send(map[string]any{"type": "show_model", "id": "r5", "name": "nope:latest"})
	if m := b.recv(wait); m["code"] != "E_MODEL_NOT_FOUND" {
		t.Errorf("missing model = %v", m)
	}
	b.send(map[string]any{"type": "delete_model", "id": "r6", "name": "fake:latest"})
	if m := b.recv(wait); m["type"] != "ok" || m["id"] != "r6" {
		t.Errorf("delete = %v", m)
	}
	// Ollama down → E_OLLAMA_DOWN.
	h.ollama.Close()
	b.send(map[string]any{"type": "list_models", "id": "r7"})
	if m := b.recv(wait); m["code"] != "E_OLLAMA_DOWN" {
		t.Errorf("ollama down = %v", m)
	}
	// device_info broadcast on status change.
	h.manager.BroadcastDeviceInfo()
	if m := b.recv(wait); m["type"] != "device_info" {
		t.Errorf("broadcast = %v", m)
	}
}

func TestChatStreamAbortBusyAndHistory(t *testing.T) {
	h := newHarness(t, harnessOpts{burst: 100})
	h.ollama.ChatDelay = 15 * time.Millisecond
	h.ollama.ChatTokens = []string{"Hel", "lo", ",", " wor", "ld", "!"}
	h.ollama.ChatThinking = []string{"think"}
	b := h.open("c1")
	b.handshake(true)

	conv, _ := history.NewUUID()
	b.send(map[string]any{"type": "chat", "id": "ch1", "conversation_id": conv, "mode": "private", "model": "fake:latest",
		"messages": []map[string]any{{"role": "user", "content": "Oi, tudo bem?"}}, "options": map[string]any{"temperature": 0.1}, "think": true})
	var content, thinking string
	chunks := 0
	var done map[string]any
	for done == nil {
		m := b.recv(wait)
		switch m["type"] {
		case "chat_chunk":
			chunks++
			if m["id"] != "ch1" {
				t.Fatalf("chunk id = %v", m["id"])
			}
			content += m["content"].(string)
			if th, ok := m["thinking"].(string); ok {
				thinking += th
			}
		case "chat_done":
			done = m
		default:
			t.Fatalf("unexpected %v", m)
		}
	}
	if content != "Hello, world!" || thinking != "think" {
		t.Errorf("content=%q thinking=%q", content, thinking)
	}
	if chunks < 2 || chunks > 7 {
		t.Errorf("chunks = %d (coalescing expected)", chunks)
	}
	if done["done_reason"] != "stop" || done["conversation_id"] != conv || done["message_id"] == nil {
		t.Errorf("chat_done = %v", done)
	}
	if st, _ := done["stats"].(map[string]any); st["eval_count"] != float64(6) {
		t.Errorf("stats = %v", done["stats"])
	}
	req := h.ollama.LastRequest("/api/chat")
	if req.Body["think"] != true || strings.Contains(string(req.Raw), `"tools"`) {
		t.Errorf("chat body = %s", req.Raw)
	}

	// History: the conversation has the user and assistant messages.
	c, msgs, _, err := h.history.Get(context.Background(), conv, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if c.Title != "Oi, tudo bem?" || c.MessageCount != 2 || len(msgs) != 2 || msgs[1].Role != "assistant" || msgs[1].Content != "Hello, world!" || msgs[1].Thinking == nil {
		t.Errorf("history = %+v / %+v", c, msgs)
	}

	// Abort: a long chat canceled by abort{target_id}.
	h.ollama.ChatTokens = []string{"1", "2", "3", "4", "5", "6", "7", "8", "9", "10"}
	h.ollama.ChatDelay = 40 * time.Millisecond
	b.send(map[string]any{"type": "chat", "id": "ch2", "conversation_id": conv, "mode": "private", "model": "fake:latest",
		"messages": []map[string]any{{"role": "user", "content": "count"}}})
	first := b.recvType("chat_chunk")
	_ = first
	b.send(map[string]any{"type": "abort", "id": "ab1", "target_id": "ch2"})
	sawOK, sawDone := false, false
	for !sawOK || !sawDone {
		m := b.recv(wait)
		switch m["type"] {
		case "ok":
			sawOK = m["id"] == "ab1"
		case "chat_done":
			sawDone = true
			if m["done_reason"] != "abort" || m["id"] != "ch2" {
				t.Errorf("chat_done after abort = %v", m)
			}
		}
	}
	_, msgs, _, _ = h.history.Get(context.Background(), conv, 0, 0)
	if len(msgs) != 4 || !msgs[3].Aborted {
		t.Errorf("aborted message not recorded: %+v", msgs)
	}
	b.send(map[string]any{"type": "abort", "id": "ab2", "target_id": "ch2"})
	if m := b.recv(wait); m["code"] != "E_NOT_FOUND" {
		t.Errorf("abort of finished chat = %v", m)
	}

	// E_BUSY: second chat while one runs.
	h.ollama.ChatDelay = 30 * time.Millisecond
	conv2, _ := history.NewUUID()
	b.send(map[string]any{"type": "chat", "id": "ch3", "conversation_id": conv2, "mode": "private", "model": "fake:latest",
		"messages": []map[string]any{{"role": "user", "content": "x"}}})
	b.send(map[string]any{"type": "chat", "id": "ch4", "conversation_id": conv2, "mode": "private", "model": "fake:latest",
		"messages": []map[string]any{{"role": "user", "content": "y"}}})
	busy := b.recvType("error")
	if busy["id"] != "ch4" || busy["code"] != "E_BUSY" || busy["retry_after_ms"] == nil {
		t.Errorf("busy = %v", busy)
	}
	if d := b.recvType("chat_done"); d["id"] != "ch3" || d["message_id"] == nil {
		t.Errorf("chat_done = %v", d)
	}
	if _, msgs2, _, err := h.history.Get(context.Background(), conv2, 0, 0); err != nil || len(msgs2) != 2 {
		t.Errorf("second conversation not stored: %v, %d messages", err, len(msgs2))
	}
	b.send(map[string]any{"type": "chat", "id": "ch3b", "conversation_id": conv2, "mode": "cloud", "model": "fake:latest",
		"messages": []map[string]any{{"role": "user", "content": "x"}}})
	if m := b.recv(wait); m["code"] != "E_INVALID" {
		t.Errorf("mode cloud (removed in rev. 1.3) must be rejected, got %v", m)
	}

	// Validation errors.
	b.send(map[string]any{"type": "chat", "id": "ch5", "conversation_id": "nope", "mode": "private", "model": "fake:latest",
		"messages": []map[string]any{{"role": "user", "content": "x"}}})
	if m := b.recv(wait); m["code"] != "E_INVALID" {
		t.Errorf("bad conversation_id = %v", m)
	}
	b.send(map[string]any{"type": "chat", "id": "ch6", "conversation_id": conv, "mode": "private", "model": "fake:latest",
		"messages": []map[string]any{{"role": "user", "content": "x"}}, "options": map[string]any{"num_gpu": 1}})
	if m := b.recv(wait); m["code"] != "E_INVALID" {
		t.Errorf("bad option = %v", m)
	}
	b.send(map[string]any{"type": "chat", "id": "ch7", "conversation_id": conv, "mode": "private", "model": "nope:latest",
		"messages": []map[string]any{{"role": "user", "content": "x"}}})
	if m := b.recvType("error"); m["code"] != "E_MODEL_NOT_FOUND" {
		t.Errorf("missing model = %v", m)
	}
	if d := b.recvType("chat_done"); d["done_reason"] != "error" {
		t.Errorf("chat_done after error = %v", d)
	}

	// History API.
	b.send(map[string]any{"type": "history_list", "id": "h1", "limit": 10})
	hl := b.recv(wait)
	if hl["type"] != "history" || len(hl["conversations"].([]any)) != 2 || hl["has_more"] != false { // conv + conv2
		t.Errorf("history = %v", hl)
	}
	b.send(map[string]any{"type": "history_get", "id": "h2", "conversation_id": conv, "after_seq": 2, "limit": 1})
	hg := b.recv(wait)
	if hg["type"] != "conversation" || hg["has_more"] != true {
		t.Errorf("conversation = %v", hg)
	}
	if ms := hg["messages"].([]any); len(ms) != 1 || ms[0].(map[string]any)["seq"] != float64(3) {
		t.Errorf("messages = %v", hg["messages"])
	}
	if cv := hg["conversation"].(map[string]any); cv["id"] != conv || cv["message_count"] != nil {
		t.Errorf("conversation head = %v", cv)
	}
	b.send(map[string]any{"type": "history_delete", "id": "h3", "conversation_id": conv})
	if m := b.recv(wait); m["type"] != "ok" {
		t.Errorf("delete = %v", m)
	}
	b.send(map[string]any{"type": "history_get", "id": "h4", "conversation_id": conv})
	if m := b.recv(wait); m["code"] != "E_NOT_FOUND" {
		t.Errorf("get deleted = %v", m)
	}
}

func TestUnknownTypeDroppedAndUndecryptableIgnored(t *testing.T) {
	h := newHarness(t, harnessOpts{burst: 100})
	b := h.open("c1")
	b.handshake(true)
	for _, typ := range []string{"exec", "ping", "create_model", ""} {
		b.send(map[string]any{"type": typ, "id": "x", "cmd": "rm -rf /"})
	}
	if m, ok := b.tryRecv(300 * time.Millisecond); ok {
		t.Fatalf("unknown type produced a reply: %v", m)
	}
	// Garbage envelope with the correct counter: dropped silently, counter not consumed.
	env := b.seal(map[string]any{"type": "list_models", "id": "g"})
	b.sendCtr-- // reuse the counter for the real message below
	env["ciphertext"] = crypto.B64([]byte("not-a-ciphertext-at-all-not-a-ciphertext"))
	b.sendRaw(env)
	if m, ok := b.tryRecv(200 * time.Millisecond); ok {
		t.Fatalf("undecryptable envelope produced a reply: %v", m)
	}
	// Envelope for another device id: dropped.
	env = b.seal(map[string]any{"type": "list_models", "id": "g2"})
	b.sendCtr--
	env["device_id"] = "11111111-2222-4333-8444-555555555555"
	b.sendRaw(env)
	if m, ok := b.tryRecv(200 * time.Millisecond); ok {
		t.Fatalf("foreign device envelope produced a reply: %v", m)
	}
	b.send(map[string]any{"type": "list_models", "id": "ok1"})
	if m := b.recv(wait); m["type"] != "models" || m["id"] != "ok1" {
		t.Errorf("session broken after drops: %v", m)
	}
	// Nothing was ever sent to Ollama for the unknown types.
	for _, r := range h.ollama.Requests() {
		if r.Path != "/api/tags" {
			t.Errorf("unexpected Ollama request %s", r.Path)
		}
	}
}

func TestReplayedCounterClosesSession(t *testing.T) {
	h := newHarness(t, harnessOpts{burst: 100})
	b := h.open("c1")
	b.handshake(true)
	env := b.seal(map[string]any{"type": "list_models", "id": "r1"})
	b.sendRaw(env)
	if m := b.recv(wait); m["type"] != "models" {
		t.Fatalf("models = %v", m)
	}
	b.sendRaw(env) // replay of counter 0
	if reason, ok := b.sess.Closed(wait); !ok || reason != "device" {
		t.Fatalf("session not closed by device (reason=%q ok=%v)", reason, ok)
	}
	if h.manager.Sessions() != 0 {
		t.Errorf("sessions = %d", h.manager.Sessions())
	}
	if m, ok := b.tryRecv(200 * time.Millisecond); ok {
		t.Errorf("reply after close: %v", m)
	}
}

func TestRateLimit(t *testing.T) {
	h := newHarness(t, harnessOpts{burst: 5})
	b := h.open("c1")
	b.handshake(true)
	for i := 0; i < 8; i++ {
		b.send(map[string]any{"type": "list_running", "id": "q"})
	}
	limited := 0
	served := 0
	for i := 0; i < 8; i++ {
		m := b.recv(wait)
		switch {
		case m["type"] == "running":
			served++
		case m["code"] == "E_RATE_LIMIT":
			limited++
			if m["retry_after_ms"] == nil {
				t.Error("no retry_after_ms")
			}
		default:
			t.Errorf("unexpected %v", m)
		}
	}
	if served != 5 || limited != 3 {
		t.Errorf("served=%d limited=%d", served, limited)
	}
}

func TestOversizeMessage(t *testing.T) {
	h := newHarness(t, harnessOpts{burst: 100, maxFrameBytes: 16 << 20})
	b := h.open("c1")
	b.handshake(true)
	conv, _ := history.NewUUID()
	// Just above the old 1 MiB limit is fine now...
	b.send(map[string]any{"type": "chat", "id": "mid", "conversation_id": conv, "mode": "private", "model": "fake:latest",
		"messages": []map[string]any{{"role": "user", "content": strings.Repeat("a", (1<<20)+10)}}})
	if m := b.recvType("chat_done"); m["done_reason"] != "stop" {
		t.Errorf("1 MiB chat = %v", m)
	}
	// ...8 MiB is the limit.
	b.send(map[string]any{"type": "chat", "id": "big", "conversation_id": conv, "mode": "private", "model": "fake:latest",
		"messages": []map[string]any{{"role": "user", "content": strings.Repeat("a", (8<<20)+10)}}})
	if m := b.recv(wait); m["code"] != "E_TOO_LARGE" || m["id"] != "big" {
		t.Errorf("oversize = %v", m)
	}
	if n := len(h.ollama.Requests()); n != 1 {
		t.Errorf("%d chat requests reached Ollama, want 1 (the oversize one must not)", n)
	}
}

// Minimal byte strings that start with the accepted magic numbers (the fake never decodes them).
var (
	tinyJPEG = []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0x00, 0xFF, 0xD9}
	tinyPNG  = []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 'I', 'H', 'D', 'R'}
	tinyWebP = []byte("RIFF\x10\x00\x00\x00WEBPVP8 ")
	tinyGIF  = []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;")
)

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// runChat sends a chat and collects the reply until chat_done (or the first error).
func (b *browser) runChat(id string, req map[string]any) (done map[string]any, errMsg map[string]any) {
	b.h.t.Helper()
	req["type"], req["id"] = "chat", id
	b.send(req)
	for {
		m := b.recv(wait)
		switch m["type"] {
		case "chat_chunk":
		case "chat_done":
			return m, errMsg
		case "error":
			if errMsg == nil {
				errMsg = m
			}
			if m["code"] == "E_INVALID" || m["code"] == "E_TOO_LARGE" || m["code"] == "E_BUSY" {
				return nil, m // validation errors have no chat_done
			}
		default:
			b.h.t.Fatalf("unexpected %v", m)
		}
	}
}

func TestChatImages(t *testing.T) {
	h := newHarness(t, harnessOpts{burst: 100, maxFrameBytes: 16 << 20})
	b := h.open("c1")
	b.handshake(true)
	conv, _ := history.NewUUID()

	// Four valid images (one of each type), one of them unpadded, plus text-only turns around it.
	unpadded := strings.TrimRight(b64(tinyWebP), "=")
	if unpadded == b64(tinyWebP) {
		t.Fatal("test image needs padding to exercise the unpadded path")
	}
	done, errMsg := b.runChat("img1", map[string]any{"conversation_id": conv, "mode": "private", "model": "fake:latest",
		"messages": []map[string]any{
			{"role": "system", "content": "be brief"},
			{"role": "user", "content": "describe", "images": []string{b64(tinyJPEG), b64(tinyPNG), unpadded, b64(tinyGIF)}},
		}})
	if errMsg != nil || done["done_reason"] != "stop" || done["message_id"] == nil {
		t.Fatalf("chat with images: done=%v err=%v", done, errMsg)
	}
	req := h.ollama.LastRequest("/api/chat")
	if req == nil {
		t.Fatal("no chat request")
	}
	if _, top := req.Body["images"]; top {
		t.Errorf("images at the top level of the Ollama body")
	}
	wire := req.Body["messages"].([]any)
	if len(wire) != 2 {
		t.Fatalf("messages = %v", wire)
	}
	if _, has := wire[0].(map[string]any)["images"]; has {
		t.Errorf("system message carries images: %v", wire[0])
	}
	got, _ := wire[1].(map[string]any)["images"].([]any)
	want := []string{b64(tinyJPEG), b64(tinyPNG), b64(tinyWebP), b64(tinyGIF)}
	if len(got) != 4 {
		t.Fatalf("user message images = %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("image %d forwarded as %v, want canonical base64 %q", i, got[i], want[i])
		}
	}
	for _, forbidden := range []string{"tools", "format", "raw", "template", "insecure"} {
		if strings.Contains(string(req.Raw), `"`+forbidden+`"`) {
			t.Errorf("chat body contains %q", forbidden)
		}
	}

	// Private history returns the images byte-for-byte (canonical base64 of the decoded bytes).
	b.send(map[string]any{"type": "history_get", "id": "hg", "conversation_id": conv})
	hg := b.recv(wait)
	if hg["type"] != "conversation" || hg["has_more"] != false {
		t.Fatalf("history_get = %v", hg)
	}
	ms := hg["messages"].([]any)
	if len(ms) != 2 || ms[0].(map[string]any)["role"] != "user" || ms[0].(map[string]any)["content"] != "describe" {
		t.Fatalf("messages = %v", ms)
	}
	stored, _ := ms[0].(map[string]any)["images"].([]any)
	if len(stored) != 4 {
		t.Fatalf("stored images = %v", stored)
	}
	for i, raw := range [][]byte{tinyJPEG, tinyPNG, tinyWebP, tinyGIF} {
		dec, err := base64.StdEncoding.DecodeString(stored[i].(string))
		if err != nil || !bytes.Equal(dec, raw) {
			t.Errorf("stored image %d = %q (err=%v), want bytes % x", i, stored[i], err, raw)
		}
	}
	if _, has := ms[1].(map[string]any)["images"]; has {
		t.Errorf("assistant message has images: %v", ms[1])
	}

	// An image-only user message (empty content) is also stored.
	if done, errMsg := b.runChat("img2", map[string]any{"conversation_id": conv, "mode": "private", "model": "fake:latest",
		"messages": []map[string]any{{"role": "user", "content": "", "images": []string{b64(tinyPNG)}}}}); errMsg != nil || done["done_reason"] != "stop" {
		t.Fatalf("image-only chat: done=%v err=%v", done, errMsg)
	}
	if _, msgs, _, err := h.history.Get(context.Background(), conv, 0, 0); err != nil || len(msgs) != 4 || len(msgs[2].Images) != 1 || msgs[2].Content != "" {
		t.Errorf("image-only message not stored: %+v err=%v", msgs, err)
	}

	// Rejections: every one is E_INVALID, nothing reaches Ollama, nothing is written.
	before := len(h.ollama.Requests())
	oversize := append(append([]byte{}, tinyPNG...), make([]byte, channel.MaxImageBytes)...)
	cases := []struct {
		name string
		msgs []map[string]any
		want string
	}{
		{"invalid base64", []map[string]any{{"role": "user", "content": "x", "images": []string{"@@not base64@@"}}}, "base64"},
		{"data url", []map[string]any{{"role": "user", "content": "x", "images": []string{"data:image/png;base64," + b64(tinyPNG)}}}, "base64"},
		{"wrong magic", []map[string]any{{"role": "user", "content": "x", "images": []string{b64([]byte("<svg xmlns='http://www.w3.org/2000/svg'/>"))}}}, "unsupported image type"},
		{"bmp", []map[string]any{{"role": "user", "content": "x", "images": []string{b64([]byte("BM\x00\x00\x00\x00\x00\x00"))}}}, "unsupported image type"},
		{"five images", []map[string]any{{"role": "user", "content": "x", "images": []string{b64(tinyPNG), b64(tinyPNG), b64(tinyPNG), b64(tinyPNG), b64(tinyPNG)}}}, "too many images"},
		{"oversize", []map[string]any{{"role": "user", "content": "x", "images": []string{b64(oversize)}}}, "image too large"},
		{"assistant", []map[string]any{{"role": "user", "content": "x"}, {"role": "assistant", "content": "y", "images": []string{b64(tinyPNG)}}}, "user messages"},
		{"system", []map[string]any{{"role": "system", "content": "x", "images": []string{b64(tinyPNG)}}, {"role": "user", "content": "y"}}, "user messages"},
		{"empty image", []map[string]any{{"role": "user", "content": "x", "images": []string{""}}}, "base64"},
	}
	for i, c := range cases {
		conv2, _ := history.NewUUID()
		done, errMsg := b.runChat(fmt.Sprintf("bad%d", i), map[string]any{"conversation_id": conv2, "mode": "private", "model": "fake:latest", "messages": c.msgs})
		if done != nil || errMsg == nil || errMsg["code"] != "E_INVALID" {
			t.Errorf("%s: done=%v err=%v", c.name, done, errMsg)
			continue
		}
		if msg, _ := errMsg["message"].(string); !strings.Contains(msg, c.want) {
			t.Errorf("%s: message %q does not mention %q", c.name, msg, c.want)
		}
		if _, _, _, err := h.history.Get(context.Background(), conv2, 0, 0); err == nil {
			t.Errorf("%s: rejected chat wrote history", c.name)
		}
	}
	if n := len(h.ollama.Requests()); n != before {
		t.Errorf("%d rejected chats reached Ollama", n-before)
	}
	// Exactly MaxImageBytes is accepted.
	exact := append(append([]byte{}, tinyPNG...), make([]byte, channel.MaxImageBytes-len(tinyPNG))...)
	if done, errMsg := b.runChat("exact", map[string]any{"conversation_id": conv, "mode": "private", "model": "fake:latest",
		"messages": []map[string]any{{"role": "user", "content": "x", "images": []string{b64(exact)}}}}); errMsg != nil || done["done_reason"] != "stop" {
		t.Errorf("image of exactly MaxImageBytes: done=%v err=%v", done, errMsg)
	}
}

func TestHistoryGetPageBudget(t *testing.T) {
	h := newHarness(t, harnessOpts{burst: 100, maxFrameBytes: 16 << 20})
	b := h.open("c1")
	b.handshake(true)
	conv, _ := history.NewUUID()
	// Four private chats, each with one ~2 MiB image (~2.8 MiB as base64): a 6 MiB page holds
	// two of them, so history_get must page twice.
	img := append(append([]byte{}, tinyPNG...), bytes.Repeat([]byte{0x5A}, 2<<20)...)
	for i := 0; i < 4; i++ {
		done, errMsg := b.runChat(fmt.Sprintf("c%d", i), map[string]any{"conversation_id": conv, "mode": "private", "model": "fake:latest",
			"messages": []map[string]any{{"role": "user", "content": fmt.Sprintf("pic %d", i), "images": []string{b64(img)}}}})
		if errMsg != nil || done["done_reason"] != "stop" {
			t.Fatalf("chat %d: done=%v err=%v", i, done, errMsg)
		}
	}
	var seqs []float64
	var after float64
	pages := 0
	for {
		b.send(map[string]any{"type": "history_get", "id": "pg", "conversation_id": conv, "after_seq": after})
		m, size := b.recvSized(wait)
		if m["type"] != "conversation" {
			t.Fatalf("history_get = %v", m)
		}
		if size > 6<<20 {
			t.Errorf("page %d plaintext is %d bytes > 6 MiB", pages, size)
		}
		ms := m["messages"].([]any)
		if len(ms) == 0 {
			t.Fatalf("empty page after seq %v", after)
		}
		images := 0
		for _, x := range ms {
			mm := x.(map[string]any)
			seqs = append(seqs, mm["seq"].(float64))
			if imgs, _ := mm["images"].([]any); len(imgs) > 0 {
				images++
				if dec, err := base64.StdEncoding.DecodeString(imgs[0].(string)); err != nil || !bytes.Equal(dec, img) {
					t.Errorf("image of seq %v does not round-trip", mm["seq"])
				}
			}
		}
		if images > 2 {
			t.Errorf("page %d has %d images (%d bytes)", pages, images, size)
		}
		pages++
		after = seqs[len(seqs)-1]
		if m["has_more"] != true {
			break
		}
	}
	if pages != 2 || len(seqs) != 8 {
		t.Errorf("pages=%d messages=%d, want 2 pages with all 8 messages", pages, len(seqs))
	}
	for i, s := range seqs {
		if s != float64(i+1) {
			t.Fatalf("seqs = %v", seqs)
		}
	}
}

func TestPullModel(t *testing.T) {
	h := newHarness(t, harnessOpts{burst: 100})
	h.ollama.PullDelay = 10 * time.Millisecond
	b := h.open("c1")
	b.handshake(true)
	b.send(map[string]any{"type": "pull_model", "id": "p0", "name": "noTag"})
	if m := b.recv(wait); m["code"] != "E_BAD_MODEL_NAME" {
		t.Errorf("bad pull name = %v", m)
	}
	b.send(map[string]any{"type": "pull_model", "id": "p1", "name": "fake:latest"})
	b.send(map[string]any{"type": "pull_model", "id": "p2", "name": "other:7b"})
	progress := 0
	var last map[string]any
	for {
		m := b.recv(wait)
		if m["type"] == "error" && m["id"] == "p2" {
			if m["code"] != "E_PULL_BUSY" {
				t.Errorf("second pull = %v", m)
			}
			continue
		}
		if m["type"] == "pull_progress" {
			progress++
			last = m
			continue
		}
		if m["type"] == "pull_done" {
			if m["id"] != "p1" || m["name"] != "fake:latest" {
				t.Errorf("pull_done = %v", m)
			}
			break
		}
		t.Fatalf("unexpected %v", m)
	}
	if progress < 1 || progress > 6 || last["status"] != "success" {
		t.Errorf("progress frames = %d last=%v", progress, last)
	}
	if req := h.ollama.LastRequest("/api/pull"); strings.Contains(string(req.Raw), "insecure") || req.Body["model"] != "fake:latest" {
		t.Errorf("pull body = %s", req.Raw)
	}
	deadline := time.Now().Add(wait)
	for len(h.notes.all()) < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	n := h.notes.all()
	if len(n) != 2 || !strings.Contains(n[0], "Downloading fake:latest") || !strings.Contains(n[1], "Downloaded fake:latest (100 B)") {
		t.Errorf("notifications = %v", n)
	}
	b.send(map[string]any{"type": "pull_model", "id": "p3", "name": "missing:latest"})
	if m := b.recvType("error"); m["code"] != "E_OLLAMA_ERROR" || !strings.Contains(m["message"].(string), "500") {
		t.Errorf("failed pull = %v", m)
	}
}

func TestHandshakeFailures(t *testing.T) {
	h := newHarness(t, harnessOpts{burst: 100})
	b := h.open("c1")
	// Unknown pairing → reject.
	eph, _ := crypto.NewEphemeral()
	b.sendRaw(map[string]any{"v": 1, "hs": "hello", "pairing_id": crypto.B64(make([]byte, 16)), "eph_pub": crypto.B64(eph.PublicKey().Bytes())})
	if m, _ := b.nextRaw(wait); m["hs"] != "reject" || m["code"] != "E_UNKNOWN_PAIRING" {
		t.Errorf("unknown pairing = %v", m)
	}
	// Wrong version → reject E_VERSION.
	b.sendRaw(map[string]any{"v": 2, "hs": "hello", "pairing_id": crypto.B64(h.pid), "eph_pub": crypto.B64(eph.PublicKey().Bytes())})
	if m, _ := b.nextRaw(wait); m["hs"] != "reject" || m["code"] != "E_VERSION" {
		t.Errorf("bad version = %v", m)
	}
	// Wrong confirm MAC → dropped; envelopes are not accepted; a fresh hello works.
	b.sendRaw(map[string]any{"v": 1, "hs": "hello", "pairing_id": crypto.B64(h.pid), "eph_pub": crypto.B64(eph.PublicKey().Bytes())})
	if m, _ := b.nextRaw(wait); m["hs"] != "hello_ack" {
		t.Fatalf("hello_ack = %v", m)
	}
	b.sendRaw(map[string]any{"v": 1, "hs": "confirm", "mac": crypto.B64(make([]byte, 32))})
	if m, ok := b.nextRaw(200 * time.Millisecond); ok {
		t.Fatalf("bad confirm produced %v", m)
	}
	// A payload without hs/ciphertext is dropped too.
	b.sendRaw(map[string]any{"v": 1, "type": "list_models", "id": "plain"})
	if m, ok := b.nextRaw(200 * time.Millisecond); ok {
		t.Fatalf("plaintext request produced %v", m)
	}
	b.handshake(true)
	b.send(map[string]any{"type": "list_models", "id": "ok"})
	if m := b.recv(wait); m["type"] != "models" {
		t.Errorf("after re-handshake = %v", m)
	}
	// Session closed by the relay: state discarded.
	h.relay.CloseSession("c1", "client")
	deadline := time.Now().Add(wait)
	for h.manager.Sessions() != 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if h.manager.Sessions() != 0 {
		t.Error("session not discarded")
	}
}

func TestHistoryTotalsAndClear(t *testing.T) {
	h := newHarness(t, harnessOpts{burst: 100})
	b := h.open("c1")
	b.handshake(true)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		id, _ := history.NewUUID()
		if _, err := h.history.EnsureConversation(ctx, id, fmt.Sprintf("c%d", i), "fake:latest"); err != nil {
			t.Fatal(err)
		}
		if _, err := h.history.AppendMessage(ctx, id, history.NewMessage{Role: "user", Content: "hello"}); err != nil {
			t.Fatal(err)
		}
	}
	b.send(map[string]any{"type": "history_list", "id": "l1", "limit": 1})
	l := b.recv(wait)
	if l["total_conversations"] != float64(2) || l["total_bytes"].(float64) <= 0 || len(l["conversations"].([]any)) != 1 {
		t.Fatalf("history totals = %v", l)
	}
	b.send(map[string]any{"type": "history_clear", "id": "x1"})
	if m := b.recv(wait); m["type"] != "ok" || m["id"] != "x1" {
		t.Fatalf("history_clear = %v", m)
	}
	b.send(map[string]any{"type": "history_list", "id": "l2"})
	l = b.recv(wait)
	if l["total_conversations"] != float64(0) || len(l["conversations"].([]any)) != 0 {
		t.Fatalf("after clear = %v", l)
	}
}

func TestChatIncognitoLeavesNoHistory(t *testing.T) {
	h := newHarness(t, harnessOpts{burst: 100})
	h.ollama.ChatTokens = []string{"kept", " nowhere"}
	b := h.open("c1")
	b.handshake(true)

	conv, _ := history.NewUUID()
	b.send(map[string]any{"type": "chat", "id": "ci1", "conversation_id": conv, "mode": "incognito", "model": "fake:latest",
		"messages": []map[string]any{{"role": "user", "content": "do not keep this"}}})
	var done map[string]any
	for done == nil {
		m := b.recv(wait)
		switch m["type"] {
		case "chat_chunk":
		case "chat_done":
			done = m
		default:
			t.Fatalf("unexpected %v", m)
		}
	}
	if done["done_reason"] != "stop" || done["conversation_id"] != conv {
		t.Errorf("chat_done = %v", done)
	}
	if id, _ := done["message_id"].(string); id != "" {
		t.Errorf("incognito chat_done must carry no message_id, got %q", id)
	}
	if _, _, _, err := h.history.Get(context.Background(), conv, 0, 0); err == nil {
		t.Errorf("incognito chat must leave no conversation in the history")
	}
	if req := h.ollama.LastRequest("/api/chat"); req == nil || !strings.Contains(string(req.Raw), "do not keep this") {
		t.Errorf("the prompt must still reach Ollama")
	}

	// Any other mode is rejected before touching anything.
	b.send(map[string]any{"type": "chat", "id": "ci2", "conversation_id": conv, "mode": "ephemeral", "model": "fake:latest",
		"messages": []map[string]any{{"role": "user", "content": "x"}}})
	if m := b.recvType("error"); m["code"] != "E_INVALID" {
		t.Errorf("unknown mode must be E_INVALID, got %v", m)
	}
}

func TestPullOutlivesItsSessionAndCanBeJoined(t *testing.T) {
	h := newHarness(t, harnessOpts{burst: 100})
	h.ollama.PullDelay = 80 * time.Millisecond
	a := h.open("c1")
	a.handshake(true)
	a.send(map[string]any{"type": "pull_model", "id": "p1", "name": "fake:latest"})
	if m := a.recvType("pull_progress"); m["id"] != "p1" {
		t.Fatalf("progress = %v", m)
	}
	// The browser leaves: the download goes on.
	h.manager.OnSessionClosed("c1", "gone")
	// Another browser learns about it in device_info and joins it with the same name.
	b := h.open("c2")
	info := b.handshake(true)
	if p, _ := info["pull"].(map[string]any); p["name"] != "fake:latest" {
		t.Fatalf("device_info.pull = %v", info["pull"])
	}
	b.send(map[string]any{"type": "pull_model", "id": "p2", "name": "fake:latest"})
	if m := b.recvType("pull_done"); m["id"] != "p2" || m["name"] != "fake:latest" {
		t.Fatalf("joined pull_done = %v", m)
	}
	pulls := 0
	for _, r := range h.ollama.Requests() {
		if r.Path == "/api/pull" {
			pulls++
		}
	}
	if pulls != 1 {
		t.Errorf("joining must not start another download (%d requests)", pulls)
	}
	// No pull running any more.
	b.send(map[string]any{"type": "list_running", "id": "r1"})
	b.recvType("running")

	// A request waiting for the download cancels it with abort.
	b.send(map[string]any{"type": "pull_model", "id": "p3", "name": "other:7b"})
	b.recvType("pull_progress")
	b.send(map[string]any{"type": "abort", "id": "x1", "target_id": "p3"})
	for {
		m := b.recv(wait)
		if m["type"] == "error" && m["id"] == "p3" {
			if m["message"] != "pull canceled" {
				t.Errorf("canceled pull = %v", m)
			}
			break
		}
	}
}
