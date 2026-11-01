// Package ollamatest is an in-process fake of the Ollama HTTP API for tests. It implements
// exactly the endpoints of the fixed table (SPEC §8.1) and records every request body so tests
// can assert what was sent (e.g. that "tools" never appears).
package ollamatest

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"
)

// Request is one recorded request.
type Request struct {
	Method string
	Path   string
	Body   map[string]any
	Raw    []byte
}

// Server is the fake. Fields may be adjusted by tests before the request arrives.
type Server struct {
	*httptest.Server

	mu       sync.Mutex
	requests []Request

	// Models is what /api/tags returns; "name" must be present.
	Models []map[string]any
	// Running is what /api/ps returns.
	Running []map[string]any
	// ChatTokens are emitted one per line by /api/chat, with ChatDelay between them.
	ChatTokens []string
	// ChatThinking is emitted (one per line, before content tokens) when non-empty.
	ChatThinking []string
	// ChatDelay is the pause between streamed lines.
	ChatDelay time.Duration
	// ChatDoneReason is the done_reason of the last line.
	ChatDoneReason string
	// ChatToolCalls, when set, is attached to the last content line as "tool_calls".
	ChatToolCalls []map[string]any
	// PullSteps are the status lines of /api/pull (a final "success" is appended).
	PullSteps []map[string]any
	// PullDelay is the pause between pull lines.
	PullDelay time.Duration
	// Version is returned by /api/version.
	Version string
	// Fail, when non-zero, makes every endpoint answer that HTTP status with {"error":FailMessage}.
	Fail        int
	FailMessage string
}

// New starts a fake with sensible defaults.
func New() *Server {
	s := &Server{
		Version: "0.0.0-fake",
		Models: []map[string]any{{
			"name": "fake:latest", "size": 1234, "modified_at": "2026-01-01T00:00:00Z",
			"digest": "sha256:abc",
			"details": map[string]any{"family": "fake", "parameter_size": "0.5B",
				"quantization_level": "Q4_0", "format": "gguf"},
		}},
		Running:        []map[string]any{},
		ChatTokens:     []string{"Hello", ",", " world"},
		ChatDoneReason: "stop",
		PullSteps: []map[string]any{
			{"status": "pulling manifest"},
			{"status": "pulling sha256:1", "digest": "sha256:1", "total": 100, "completed": 50},
			{"status": "pulling sha256:1", "digest": "sha256:1", "total": 100, "completed": 100},
			{"status": "verifying sha256 digest"},
			{"status": "writing manifest"},
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/version", s.wrap(s.version))
	mux.HandleFunc("/api/tags", s.wrap(s.tags))
	mux.HandleFunc("/api/ps", s.wrap(s.ps))
	mux.HandleFunc("/api/show", s.wrap(s.show))
	mux.HandleFunc("/api/chat", s.wrap(s.chat))
	mux.HandleFunc("/api/pull", s.wrap(s.pull))
	mux.HandleFunc("/api/delete", s.wrap(s.del))
	s.Server = httptest.NewServer(mux)
	return s
}

// Requests returns a copy of the recorded requests.
func (s *Server) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Request(nil), s.requests...)
}

// LastRequest returns the most recent request to path, or nil.
func (s *Server) LastRequest(path string) *Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := len(s.requests) - 1; i >= 0; i-- {
		if s.requests[i].Path == path {
			r := s.requests[i]
			return &r
		}
	}
	return nil
}

func (s *Server) wrap(h func(w http.ResponseWriter, r *http.Request, body map[string]any)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		s.mu.Lock()
		s.requests = append(s.requests, Request{Method: r.Method, Path: r.URL.Path, Body: body, Raw: raw})
		fail, msg := s.Fail, s.FailMessage
		s.mu.Unlock()
		if fail != 0 {
			w.WriteHeader(fail)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
			return
		}
		h(w, r, body)
	}
}

func (s *Server) hasModel(name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range s.Models {
		if m["name"] == name {
			return true
		}
	}
	return false
}

func notFound(w http.ResponseWriter, name string) {
	w.WriteHeader(http.StatusNotFound)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("model '%s' not found", name)})
}

func (s *Server) version(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
	_ = json.NewEncoder(w).Encode(map[string]string{"version": s.Version})
}

func (s *Server) tags(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = json.NewEncoder(w).Encode(map[string]any{"models": s.Models})
}

func (s *Server) ps(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = json.NewEncoder(w).Encode(map[string]any{"models": s.Running})
}

func (s *Server) show(w http.ResponseWriter, _ *http.Request, body map[string]any) {
	name, _ := body["model"].(string)
	if !s.hasModel(name) {
		notFound(w, name)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"license":    strings.Repeat("L", 5000),
		"parameters": "stop \"<|im_end|>\"",
		"template":   "{{ .Prompt }}",
		"details": map[string]any{"family": "fake", "parameter_size": "0.5B",
			"quantization_level": "Q4_0", "format": "gguf"},
		"capabilities": []string{"completion"},
		"model_info": map[string]any{
			"general.architecture": "fake",
			"fake.context_length":  32768,
		},
	})
}

func (s *Server) chat(w http.ResponseWriter, r *http.Request, body map[string]any) {
	name, _ := body["model"].(string)
	if !s.hasModel(name) {
		notFound(w, name)
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	fl, _ := w.(http.Flusher)
	enc := json.NewEncoder(w)
	write := func(v any) bool {
		if err := enc.Encode(v); err != nil {
			return false
		}
		if fl != nil {
			fl.Flush()
		}
		return true
	}
	s.mu.Lock()
	tokens, thinking, delay, reason, tc := s.ChatTokens, s.ChatThinking, s.ChatDelay, s.ChatDoneReason, s.ChatToolCalls
	s.mu.Unlock()
	for _, t := range thinking {
		if !write(map[string]any{"model": name, "message": map[string]any{"role": "assistant", "content": "", "thinking": t}, "done": false}) {
			return
		}
		if !sleep(r, delay) {
			return
		}
	}
	for i, t := range tokens {
		msg := map[string]any{"role": "assistant", "content": t}
		if i == len(tokens)-1 && len(tc) > 0 {
			msg["tool_calls"] = tc
		}
		if !write(map[string]any{"model": name, "message": msg, "done": false}) {
			return
		}
		if !sleep(r, delay) {
			return
		}
	}
	write(map[string]any{
		"model": name, "message": map[string]any{"role": "assistant", "content": ""},
		"done": true, "done_reason": reason,
		"total_duration": 1000, "load_duration": 100, "prompt_eval_count": 5,
		"prompt_eval_duration": 200, "eval_count": len(tokens), "eval_duration": 700,
	})
}

func (s *Server) pull(w http.ResponseWriter, r *http.Request, body map[string]any) {
	name, _ := body["model"].(string)
	if name == "missing:latest" {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "pull model manifest: file does not exist"})
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	fl, _ := w.(http.Flusher)
	enc := json.NewEncoder(w)
	s.mu.Lock()
	steps, delay := s.PullSteps, s.PullDelay
	s.mu.Unlock()
	for _, st := range steps {
		if err := enc.Encode(st); err != nil {
			return
		}
		if fl != nil {
			fl.Flush()
		}
		if !sleep(r, delay) {
			return
		}
	}
	_ = enc.Encode(map[string]any{"status": "success"})
}

func (s *Server) del(w http.ResponseWriter, r *http.Request, body map[string]any) {
	if r.Method != http.MethodDelete {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	name, _ := body["model"].(string)
	if !s.hasModel(name) {
		notFound(w, name)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func sleep(r *http.Request, d time.Duration) bool {
	if d <= 0 {
		return r.Context().Err() == nil
	}
	select {
	case <-time.After(d):
		return true
	case <-r.Context().Done():
		return false
	}
}
