package ollama_test

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/ollama"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/ollama/ollamatest"
)

func newClient(t *testing.T, srv *ollamatest.Server) *ollama.Client {
	t.Helper()
	c, err := ollama.New(srv.URL, ollama.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestLoopbackOnly(t *testing.T) {
	for _, u := range []string{"http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"} {
		if _, err := ollama.New(u, ollama.Options{}); err != nil {
			t.Errorf("%s rejected: %v", u, err)
		}
	}
	for _, u := range []string{"http://10.0.0.5:11434", "http://ollama.local", "ftp://127.0.0.1", "http://user:pw@127.0.0.1"} {
		if _, err := ollama.New(u, ollama.Options{}); err == nil {
			t.Errorf("%s accepted", u)
		}
	}
	if _, err := ollama.New("http://10.0.0.5:11434", ollama.Options{AllowNonLoopback: true}); err != nil {
		t.Errorf("non-loopback with override rejected: %v", err)
	}
}

func TestModelNames(t *testing.T) {
	good := []string{"llama3.2", "llama3.2:3b", "library/llama3:latest", "qwen2.5:0.5b", "a", "deepseek-r1:7B-Q4_K_M"}
	bad := []string{"", "Llama3", "llama3:", "/x", "a/b/c", "llama3@sha256:abc", "llama 3", strings.Repeat("a", 70)}
	for _, n := range good {
		if err := ollama.ValidateModelName(n); err != nil {
			t.Errorf("ValidateModelName(%q) = %v", n, err)
		}
	}
	for _, n := range bad {
		if err := ollama.ValidateModelName(n); err == nil {
			t.Errorf("ValidateModelName(%q) accepted", n)
		}
	}
	pullGood := []string{"llama3.2:3b", "qwen2.5:0.5b", "ns/llama3:latest"}
	pullBad := []string{"llama3.2", "ns/llama3", "llama3:3b@sha256:abc", "Llama:3b", "a/b/c:d"}
	for _, n := range pullGood {
		if err := ollama.ValidatePullName(n); err != nil {
			t.Errorf("ValidatePullName(%q) = %v", n, err)
		}
	}
	for _, n := range pullBad {
		if err := ollama.ValidatePullName(n); err == nil {
			t.Errorf("ValidatePullName(%q) accepted", n)
		}
	}
}

func TestChatOptions(t *testing.T) {
	good := []string{
		`{"temperature":0.7,"top_p":0.9,"top_k":40,"num_ctx":4096,"num_predict":-1,"repeat_penalty":1.1,"seed":42,"stop":["a","b"]}`,
		`{}`, `null`, ``,
	}
	for _, raw := range good {
		if _, err := ollama.ParseChatOptions([]byte(raw)); err != nil {
			t.Errorf("ParseChatOptions(%s) = %v", raw, err)
		}
	}
	bad := []string{
		`{"num_gpu":1}`, `{"temperature":2.5}`, `{"top_p":1.5}`, `{"top_k":0}`, `{"num_ctx":100}`,
		`{"num_predict":0}`, `{"num_predict":-2}`, `{"repeat_penalty":4}`, `{"seed":-1}`, `{"seed":2147483648}`,
		`{"stop":["a","b","c","d","e","f","g","h","i"]}`, `{"stop":["` + strings.Repeat("x", 65) + `"]}`,
		`{"top_k":1.5}`, `[1]`, `{"temperature":"hot"}`,
	}
	for _, raw := range bad {
		if _, err := ollama.ParseChatOptions([]byte(raw)); err == nil {
			t.Errorf("ParseChatOptions(%s) accepted", raw)
		}
	}
}

func TestFixedTable(t *testing.T) {
	srv := ollamatest.New()
	defer srv.Close()
	c := newClient(t, srv)
	ctx := context.Background()

	v, err := c.Version(ctx)
	if err != nil || v != "0.0.0-fake" {
		t.Fatalf("Version = %q, %v", v, err)
	}
	models, err := c.ListModels(ctx)
	if err != nil || len(models) != 1 || models[0].Name != "fake:latest" || models[0].Details.Family != "fake" {
		t.Fatalf("ListModels = %+v, %v", models, err)
	}
	running, err := c.ListRunning(ctx)
	if err != nil || len(running) != 0 {
		t.Fatalf("ListRunning = %+v, %v", running, err)
	}
	info, err := c.ShowModel(ctx, "fake:latest")
	if err != nil {
		t.Fatal(err)
	}
	if info.ContextLength == nil || *info.ContextLength != 32768 || len(info.License) != 4096 || info.Template != "{{ .Prompt }}" {
		t.Errorf("ShowModel = %+v", info)
	}
	if req := srv.LastRequest("/api/show"); req == nil || req.Body["model"] != "fake:latest" {
		t.Errorf("show body = %+v", req)
	}
	if _, err := c.ShowModel(ctx, "nope:latest"); !ollama.IsNotFound(err) {
		t.Errorf("ShowModel(missing) = %v", err)
	}
	if _, err := c.ShowModel(ctx, "Bad Name"); !errors.Is(err, ollama.ErrBadModelName) {
		t.Errorf("ShowModel(bad) = %v", err)
	}
	if err := c.Delete(ctx, "fake:latest"); err != nil {
		t.Errorf("Delete = %v", err)
	}
	if req := srv.LastRequest("/api/delete"); req == nil || req.Method != "DELETE" || req.Body["model"] != "fake:latest" {
		t.Errorf("delete request = %+v", req)
	}
	if err := c.Delete(ctx, "nope:latest"); !ollama.IsNotFound(err) {
		t.Errorf("Delete(missing) = %v", err)
	}
}

func TestChatStreamAndWire(t *testing.T) {
	srv := ollamatest.New()
	defer srv.Close()
	srv.ChatThinking = []string{"hmm"}
	srv.ChatToolCalls = []map[string]any{{"function": map[string]any{"name": "f", "arguments": map[string]any{"a": 1}}}}
	c := newClient(t, srv)
	think := true
	temp := 0.5
	var chunks []ollama.ChatChunk
	res, err := c.Chat(context.Background(), ollama.ChatRequest{
		Model:     "fake:latest",
		Messages:  []ollama.Message{{Role: "user", Content: "hi"}},
		Options:   &ollama.ChatOptions{Temperature: &temp},
		Think:     &think,
		KeepAlive: "5m",
	}, func(ch ollama.ChatChunk) { chunks = append(chunks, ch) })
	if err != nil {
		t.Fatal(err)
	}
	if res.DoneReason != "stop" || res.Stats.EvalCount != 3 || res.Stats.TotalDuration != 1000 {
		t.Errorf("result = %+v", res)
	}
	var content, thinking string
	for _, ch := range chunks {
		content += ch.Content
		thinking += ch.Thinking
	}
	if thinking != "hmm" || !strings.HasPrefix(content, "Hello, world") || !strings.Contains(content, `"name":"f"`) {
		t.Errorf("content=%q thinking=%q", content, thinking)
	}
	req := srv.LastRequest("/api/chat")
	if req == nil {
		t.Fatal("no chat request")
	}
	for _, forbidden := range []string{"tools", "format", "raw", "template", "insecure"} {
		if strings.Contains(string(req.Raw), `"`+forbidden+`"`) {
			t.Errorf("chat body contains %q: %s", forbidden, req.Raw)
		}
	}
	// A text-only chat carries no "images" anywhere.
	if strings.Contains(string(req.Raw), `"images"`) {
		t.Errorf("text-only chat body contains images: %s", req.Raw)
	}
	if req.Body["stream"] != true || req.Body["think"] != true || req.Body["keep_alive"] != "5m" {
		t.Errorf("chat body = %s", req.Raw)
	}
	if opts, _ := req.Body["options"].(map[string]any); opts == nil || opts["temperature"] != 0.5 || len(opts) != 1 {
		t.Errorf("options = %v", req.Body["options"])
	}
}

// Minimal byte strings that start with the accepted magic numbers (the fake never decodes them).
var (
	tinyJPEG = []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0x00, 0xFF, 0xD9}
	tinyPNG  = []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 'I', 'H', 'D', 'R'}
	tinyWebP = []byte("RIFF\x10\x00\x00\x00WEBPVP8 ")
	tinyGIF  = []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;")
)

func TestChatImagesWireAndValidation(t *testing.T) {
	srv := ollamatest.New()
	defer srv.Close()
	c := newClient(t, srv)
	msgs := []ollama.Message{
		{Role: "system", Content: "be brief"},
		{Role: "user", Content: "what is this?", Images: [][]byte{tinyJPEG, tinyPNG, tinyWebP, tinyGIF}},
		{Role: "assistant", Content: "a picture"},
		{Role: "user", Content: "and this?", Images: [][]byte{tinyGIF}},
	}
	if _, err := c.Chat(context.Background(), ollama.ChatRequest{Model: "fake:latest", Messages: msgs}, func(ollama.ChatChunk) {}); err != nil {
		t.Fatal(err)
	}
	req := srv.LastRequest("/api/chat")
	if req == nil {
		t.Fatal("no chat request")
	}
	if _, top := req.Body["images"]; top {
		t.Errorf("images at the top level: %s", req.Raw)
	}
	wire := req.Body["messages"].([]any)
	if len(wire) != 4 {
		t.Fatalf("messages = %v", wire)
	}
	for i, m := range wire {
		got, has := m.(map[string]any)["images"]
		want := msgs[i].Images
		if has != (len(want) > 0) {
			t.Errorf("message %d: images present=%v, want %v", i, has, len(want) > 0)
			continue
		}
		if !has {
			continue
		}
		list := got.([]any)
		if len(list) != len(want) {
			t.Fatalf("message %d: %d images, want %d", i, len(list), len(want))
		}
		for j, img := range list {
			if img != base64.StdEncoding.EncodeToString(want[j]) {
				t.Errorf("message %d image %d = %v, want std base64 of the bytes", i, j, img)
			}
		}
		for k := range m.(map[string]any) {
			if k != "role" && k != "content" && k != "images" {
				t.Errorf("message %d has unexpected key %q", i, k)
			}
		}
	}

	bad := map[string][]ollama.Message{
		"assistant":    {{Role: "assistant", Content: "x", Images: [][]byte{tinyPNG}}},
		"system":       {{Role: "system", Content: "x", Images: [][]byte{tinyPNG}}},
		"five":         {{Role: "user", Content: "x", Images: [][]byte{tinyPNG, tinyPNG, tinyPNG, tinyPNG, tinyPNG}}},
		"oversize":     {{Role: "user", Content: "x", Images: [][]byte{append(append([]byte{}, tinyPNG...), make([]byte, ollama.MaxImageBytes)...)}}},
		"bad magic":    {{Role: "user", Content: "x", Images: [][]byte{[]byte("<svg xmlns='http://www.w3.org/2000/svg'/>")}}},
		"bmp":          {{Role: "user", Content: "x", Images: [][]byte{[]byte("BM\x00\x00\x00\x00")}}},
		"riff no webp": {{Role: "user", Content: "x", Images: [][]byte{[]byte("RIFF\x10\x00\x00\x00WAVEfmt ")}}},
		"empty":        {{Role: "user", Content: "x", Images: [][]byte{{}}}},
	}
	for name, m := range bad {
		_, err := c.Chat(context.Background(), ollama.ChatRequest{Model: "fake:latest", Messages: m}, func(ollama.ChatChunk) {})
		var inv ollama.ErrInvalid
		if !errors.As(err, &inv) {
			t.Errorf("%s: err = %v, want ErrInvalid", name, err)
		}
	}
	if n := len(srv.Requests()); n != 1 {
		t.Errorf("%d requests reached Ollama, want only the valid one", n)
	}
	// Exactly MaxImageBytes is fine.
	exact := append(append([]byte{}, tinyPNG...), make([]byte, ollama.MaxImageBytes-len(tinyPNG))...)
	if _, err := c.Chat(context.Background(), ollama.ChatRequest{Model: "fake:latest",
		Messages: []ollama.Message{{Role: "user", Content: "x", Images: [][]byte{exact}}}}, func(ollama.ChatChunk) {}); err != nil {
		t.Errorf("image of exactly MaxImageBytes rejected: %v", err)
	}
}

func TestImageMIME(t *testing.T) {
	cases := map[string]string{
		string(tinyJPEG): "image/jpeg", string(tinyPNG): "image/png", string(tinyWebP): "image/webp", string(tinyGIF): "image/gif",
		"GIF87a\x00": "image/gif", "": "", "\xFF\xD8": "", "RIFF\x00\x00\x00\x00WEB": "", "\x89PNG\r\n": "", "plain text": "",
	}
	for in, want := range cases {
		if got := ollama.ImageMIME([]byte(in)); got != want {
			t.Errorf("ImageMIME(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestChatAbortAndErrors(t *testing.T) {
	srv := ollamatest.New()
	defer srv.Close()
	srv.ChatDelay = 50 * time.Millisecond
	srv.ChatTokens = []string{"a", "b", "c", "d", "e", "f"}
	c := newClient(t, srv)
	ctx, cancel := context.WithCancel(context.Background())
	n := 0
	_, err := c.Chat(ctx, ollama.ChatRequest{Model: "fake:latest", Messages: []ollama.Message{{Role: "user", Content: "hi"}}},
		func(ollama.ChatChunk) {
			n++
			if n == 2 {
				cancel()
			}
		})
	if !errors.Is(err, context.Canceled) {
		t.Errorf("abort: err = %v", err)
	}
	if n < 2 || n > 3 {
		t.Errorf("chunks before abort: %d", n)
	}
	_, err = c.Chat(context.Background(), ollama.ChatRequest{Model: "nope:latest", Messages: []ollama.Message{{Role: "user", Content: "hi"}}}, func(ollama.ChatChunk) {})
	if !ollama.IsNotFound(err) {
		t.Errorf("missing model: %v", err)
	}
	_, err = c.Chat(context.Background(), ollama.ChatRequest{Model: "fake:latest", Messages: []ollama.Message{{Role: "tool", Content: "x"}}}, func(ollama.ChatChunk) {})
	var inv ollama.ErrInvalid
	if !errors.As(err, &inv) {
		t.Errorf("bad role: %v", err)
	}
	srv.Close()
	_, err = c.Version(context.Background())
	if !ollama.IsUnreachable(err) {
		t.Errorf("closed server: %v", err)
	}
}

func TestPull(t *testing.T) {
	srv := ollamatest.New()
	defer srv.Close()
	c := newClient(t, srv)
	var progress []ollama.PullProgress
	if err := c.Pull(context.Background(), "fake:latest", func(p ollama.PullProgress) { progress = append(progress, p) }); err != nil {
		t.Fatal(err)
	}
	if len(progress) != 6 || progress[1].Total != 100 || progress[5].Status != "success" {
		t.Errorf("progress = %+v", progress)
	}
	req := srv.LastRequest("/api/pull")
	if req == nil || req.Body["stream"] != true || len(req.Body) != 2 {
		t.Errorf("pull body = %s", req.Raw)
	}
	if err := c.Pull(context.Background(), "fake", nil); !errors.Is(err, ollama.ErrBadModelName) {
		t.Errorf("pull without tag: %v", err)
	}
	var ae *ollama.APIError
	if err := c.Pull(context.Background(), "missing:latest", nil); !errors.As(err, &ae) || ae.StatusCode != 500 {
		t.Errorf("pull missing: %v", err)
	}
}
