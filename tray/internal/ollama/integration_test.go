package ollama_test

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/ollama"
)

// TestIntegrationRealOllama talks to a real Ollama at TUNNELIO_OLLAMA_URL (default
// http://127.0.0.1:11434). Skipped when it is not reachable.
func TestIntegrationRealOllama(t *testing.T) {
	base := os.Getenv("TUNNELIO_OLLAMA_URL")
	c, err := ollama.New(base, ollama.Options{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	version, err := c.Version(ctx)
	cancel()
	if err != nil {
		t.Skipf("Ollama not reachable at %s: %v", c.BaseURL(), err)
	}
	t.Logf("Ollama %s", version)

	models, err := c.ListModels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(models) == 0 {
		t.Skip("no models installed")
	}
	model := models[0].Name
	for _, m := range models {
		if m.Name == "qwen2.5:0.5b" {
			model = m.Name
		}
	}
	t.Logf("using model %s (%d models installed)", model, len(models))

	if _, err := c.ListRunning(context.Background()); err != nil {
		t.Fatal(err)
	}
	info, err := c.ShowModel(context.Background(), model)
	if err != nil {
		t.Fatal(err)
	}
	ctxLen := int64(0)
	if info.ContextLength != nil {
		ctxLen = *info.ContextLength
	}
	t.Logf("show: family=%s context_length=%d caps=%v", info.Details.Family, ctxLen, info.Capabilities)

	numPredict := 16
	var out strings.Builder
	chunks := 0
	res, err := c.Chat(context.Background(), ollama.ChatRequest{
		Model:    model,
		Messages: []ollama.Message{{Role: "user", Content: "Say hello in one short sentence."}},
		Options:  &ollama.ChatOptions{NumPredict: &numPredict},
	}, func(ch ollama.ChatChunk) {
		chunks++
		out.WriteString(ch.Content)
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("chat: %d chunks, done_reason=%s, eval_count=%d, text=%q", chunks, res.DoneReason, res.Stats.EvalCount, out.String())
	if chunks == 0 || res.DoneReason == "" {
		t.Errorf("unexpected chat result %+v", res)
	}

	// Abort via context cancel after the first chunk.
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	long := 256
	got := 0
	_, err = c.Chat(ctx, ollama.ChatRequest{
		Model:    model,
		Messages: []ollama.Message{{Role: "user", Content: "Count from 1 to 200, one number per line."}},
		Options:  &ollama.ChatOptions{NumPredict: &long},
	}, func(ollama.ChatChunk) {
		got++
		if got == 1 {
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) {
		t.Errorf("abort: err = %v (chunks=%d)", err, got)
	}
	t.Logf("abort: canceled after %d chunk(s)", got)

	// Vision: when moondream is installed, a generated 64x64 solid red PNG gets a reply.
	vision := ""
	for _, m := range models {
		if m.Name == "moondream" || strings.HasPrefix(m.Name, "moondream:") {
			vision = m.Name
			break
		}
	}
	if vision == "" {
		t.Log("moondream not installed; skipping the vision chat")
		return
	}
	t.Run("vision", func(t *testing.T) {
		img := image.NewRGBA(image.Rect(0, 0, 64, 64))
		for i := 0; i < len(img.Pix); i += 4 {
			img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = 0xFF, 0x00, 0x00, 0xFF
		}
		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err != nil {
			t.Fatal(err)
		}
		if ollama.ImageMIME(buf.Bytes()) != "image/png" {
			t.Fatalf("generated PNG not recognised: % x", buf.Bytes()[:8])
		}
		n := 24
		var reply strings.Builder
		chunks := 0
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		// "Describe this image." is the prompt moondream answers reliably; to some direct
		// questions ("What color is this?") it emits an immediate end-of-stream. The content
		// is not asserted, only that the image produced a streamed reply.
		res, err := c.Chat(ctx, ollama.ChatRequest{
			Model:    vision,
			Messages: []ollama.Message{{Role: "user", Content: "Describe this image.", Images: [][]byte{buf.Bytes()}}},
			Options:  &ollama.ChatOptions{NumPredict: &n},
		}, func(ch ollama.ChatChunk) {
			chunks++
			reply.WriteString(ch.Content)
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("vision chat (%s): %d chunks, done_reason=%s, reply=%q", vision, chunks, res.DoneReason, reply.String())
		if chunks == 0 || strings.TrimSpace(reply.String()) == "" {
			t.Errorf("empty vision reply: chunks=%d res=%+v", chunks, res)
		}
	})
}
