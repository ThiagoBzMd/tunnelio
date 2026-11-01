package ollama

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
)

const (
	// DefaultBaseURL is the Ollama default listen address.
	DefaultBaseURL = "http://127.0.0.1:11434"
	// maxBodyBytes caps a streaming response body (SPEC §8.4).
	maxBodyBytes = 64 << 20
	// maxLineBytes caps one NDJSON line (SPEC §8.4).
	maxLineBytes = 1 << 20
	// maxErrorBody is how much of an error body is kept in the message (SPEC §7.5).
	maxErrorBody = 512
	// maxTextField truncates parameters/template in ModelInfo (SPEC §7.4).
	maxTextField = 8 << 10
	// maxLicense truncates license in ModelInfo (SPEC §7.4).
	maxLicense = 4 << 10
)

var (
	// ErrNotLoopback is returned by New when the base URL host is not loopback and
	// Options.AllowNonLoopback is false.
	ErrNotLoopback = errors.New("ollama: base URL host must be loopback")
	// ErrLineTooLong is returned when a streamed NDJSON line exceeds 1 MiB.
	ErrLineTooLong = errors.New("ollama: response line too long")
)

// UnreachableError wraps a transport failure (Ollama not running).
type UnreachableError struct{ Err error }

func (e *UnreachableError) Error() string { return "ollama unreachable: " + e.Err.Error() }
func (e *UnreachableError) Unwrap() error { return e.Err }

// APIError is a non-2xx response from Ollama. Message is "<status> <body truncated to 512 B>".
type APIError struct {
	StatusCode int
	Message    string
}

func (e *APIError) Error() string { return "ollama: " + e.Message }

// IsNotFound reports whether err is an APIError with status 404 (model not found).
func IsNotFound(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.StatusCode == http.StatusNotFound
}

// IsUnreachable reports whether err means Ollama did not answer at all.
func IsUnreachable(err error) bool {
	var ue *UnreachableError
	return errors.As(err, &ue)
}

// Options configures a Client.
type Options struct {
	// AllowNonLoopback permits a non-loopback host (set only from local config, SPEC §8.1).
	AllowNonLoopback bool
	// HTTPClient overrides the transport (tests). It must not have a global Timeout: chats stream.
	HTTPClient *http.Client
}

// Client talks to one Ollama server. One exported method per fixed endpoint (SPEC §8.1).
type Client struct {
	base string
	http *http.Client
}

// New validates baseURL and returns a client.
func New(baseURL string, opts Options) (*Client, error) {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	u, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("ollama: bad base URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("ollama: base URL scheme must be http or https")
	}
	if u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("ollama: base URL must be scheme://host[:port][/path]")
	}
	if !opts.AllowNonLoopback && !isLoopbackHost(u.Hostname()) {
		return nil, ErrNotLoopback
	}
	hc := opts.HTTPClient
	if hc == nil {
		hc = &http.Client{Transport: &http.Transport{Proxy: nil}} // never via a proxy
	}
	return &Client{base: strings.TrimRight(u.String(), "/"), http: hc}, nil
}

// BaseURL returns the configured base URL.
func (c *Client) BaseURL() string { return c.base }

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Version calls GET /api/version.
func (c *Client) Version(ctx context.Context) (string, error) {
	var out struct {
		Version string `json:"version"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/version", nil, &out); err != nil {
		return "", err
	}
	return out.Version, nil
}

// ListModels calls GET /api/tags.
func (c *Client) ListModels(ctx context.Context) ([]Model, error) {
	var out struct {
		Models []Model `json:"models"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/tags", nil, &out); err != nil {
		return nil, err
	}
	if out.Models == nil {
		out.Models = []Model{}
	}
	return out.Models, nil
}

// ListRunning calls GET /api/ps.
func (c *Client) ListRunning(ctx context.Context) ([]RunningModel, error) {
	var out struct {
		Models []RunningModel `json:"models"`
	}
	if err := c.doJSON(ctx, http.MethodGet, "/api/ps", nil, &out); err != nil {
		return nil, err
	}
	if out.Models == nil {
		out.Models = []RunningModel{}
	}
	return out.Models, nil
}

// ShowModel calls POST /api/show with {model}. The name must pass ValidateModelName.
func (c *Client) ShowModel(ctx context.Context, name string) (*ModelInfo, error) {
	if err := ValidateModelName(name); err != nil {
		return nil, err
	}
	var raw showResponse
	if err := c.doJSON(ctx, http.MethodPost, "/api/show", modelBody{Model: name}, &raw); err != nil {
		return nil, err
	}
	info := &ModelInfo{
		Name:         name,
		Details:      raw.Details,
		Capabilities: raw.Capabilities,
		Parameters:   truncate(raw.Parameters, maxTextField),
		Template:     truncate(raw.Template, maxTextField),
		License:      truncate(raw.License, maxLicense),
	}
	if arch, ok := raw.ModelInfo["general.architecture"]; ok {
		var archName string
		if json.Unmarshal(arch, &archName) == nil {
			if cl, ok := raw.ModelInfo[archName+".context_length"]; ok {
				var n int64
				if json.Unmarshal(cl, &n) == nil && n > 0 {
					info.ContextLength = &n
				}
			}
		}
	}
	return info, nil
}

// Delete calls DELETE /api/delete with {model}.
func (c *Client) Delete(ctx context.Context, name string) error {
	if err := ValidateModelName(name); err != nil {
		return err
	}
	return c.doJSON(ctx, http.MethodDelete, "/api/delete", modelBody{Model: name}, nil)
}

// Chat calls POST /api/chat with stream:true and invokes onChunk for every content/thinking
// delta. It returns when Ollama sends done:true, when the context is canceled, or on error.
// Never sends tools, format, template or raw (SPEC §8.1); "images" appears only inside the
// user messages that carry validated images (see validateImages), never at the top level.
func (c *Client) Chat(ctx context.Context, req ChatRequest, onChunk func(ChatChunk)) (*ChatResult, error) {
	if err := req.Validate(); err != nil {
		return nil, err
	}
	wire := chatWire{
		Model:     req.Model,
		Messages:  req.Messages,
		Stream:    true,
		Options:   req.Options,
		Think:     req.Think,
		KeepAlive: req.KeepAlive,
	}
	body, err := c.stream(ctx, "/api/chat", wire)
	if err != nil {
		return nil, err
	}
	defer func() { _ = body.Close() }()
	var result *ChatResult
	err = scanLines(body, func(line []byte) (bool, error) {
		var l chatLine
		if err := json.Unmarshal(line, &l); err != nil {
			return false, fmt.Errorf("ollama: bad chat line: %w", err)
		}
		if l.Error != "" {
			return false, &APIError{StatusCode: http.StatusOK, Message: "stream error: " + truncate(l.Error, maxErrorBody)}
		}
		content := l.Message.Content
		if len(l.Message.ToolCalls) > 0 {
			// Tool calling is out of scope: render whatever came back as text (tray rule 6).
			if tc, err := json.Marshal(l.Message.ToolCalls); err == nil {
				content += string(tc)
			}
		}
		if content != "" || l.Message.Thinking != "" {
			onChunk(ChatChunk{Content: content, Thinking: l.Message.Thinking})
		}
		if l.Done {
			result = &ChatResult{
				DoneReason: l.DoneReason,
				Stats: ChatStats{
					TotalDuration:      l.TotalDuration,
					LoadDuration:       l.LoadDuration,
					PromptEvalCount:    l.PromptEvalCount,
					PromptEvalDuration: l.PromptEvalDuration,
					EvalCount:          l.EvalCount,
					EvalDuration:       l.EvalDuration,
				},
			}
			return true, nil
		}
		return false, nil
	})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	if result == nil {
		return nil, &APIError{StatusCode: http.StatusOK, Message: "stream ended without done"}
	}
	if result.DoneReason == "" {
		result.DoneReason = "stop"
	}
	return result, nil
}

// Pull calls POST /api/pull with {model, stream:true} (never insecure). The name must pass
// ValidatePullName. onProgress is called for every status line.
func (c *Client) Pull(ctx context.Context, name string, onProgress func(PullProgress)) error {
	if err := ValidatePullName(name); err != nil {
		return err
	}
	body, err := c.stream(ctx, "/api/pull", pullWire{Model: name, Stream: true})
	if err != nil {
		return err
	}
	defer func() { _ = body.Close() }()
	err = scanLines(body, func(line []byte) (bool, error) {
		var l pullLine
		if err := json.Unmarshal(line, &l); err != nil {
			return false, fmt.Errorf("ollama: bad pull line: %w", err)
		}
		if l.Error != "" {
			return false, &APIError{StatusCode: http.StatusOK, Message: "stream error: " + truncate(l.Error, maxErrorBody)}
		}
		if onProgress != nil {
			onProgress(PullProgress{Status: l.Status, Digest: l.Digest, Total: l.Total, Completed: l.Completed})
		}
		return l.Status == "success", nil
	})
	if err != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

// ─── transport helpers ───────────────────────────────────────────────────────

type modelBody struct {
	Model string `json:"model"`
}

func (c *Client) newRequest(ctx context.Context, method, path string, body any) (*http.Request, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rdr)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	return req, nil
}

// doJSON performs a non-streaming request and decodes a JSON object into out (may be nil).
func (c *Client) doJSON(ctx context.Context, method, path string, body, out any) error {
	req, err := c.newRequest(ctx, method, path, body)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return &UnreachableError{Err: err}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return apiError(resp)
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxBodyBytes))
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return &UnreachableError{Err: err}
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("ollama: bad response from %s: %w", path, err)
	}
	return nil
}

// stream performs a streaming POST and returns the (limited) body on 2xx.
func (c *Client) stream(ctx context.Context, path string, body any) (io.ReadCloser, error) {
	req, err := c.newRequest(ctx, http.MethodPost, path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/x-ndjson")
	resp, err := c.http.Do(req) //nolint:bodyclose // the body is returned to the caller and closed there
	if err != nil {
		return nil, &UnreachableError{Err: err}
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		defer func() { _ = resp.Body.Close() }()
		return nil, apiError(resp)
	}
	return &limitedBody{Reader: io.LimitReader(resp.Body, maxBodyBytes), c: resp.Body}, nil
}

type limitedBody struct {
	io.Reader
	c io.Closer
}

func (l *limitedBody) Close() error { return l.c.Close() }

// scanLines feeds each non-empty NDJSON line to fn until fn returns stop=true or EOF.
func scanLines(r io.Reader, fn func(line []byte) (stop bool, err error)) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), maxLineBytes)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		stop, err := fn(line)
		if err != nil {
			return err
		}
		if stop {
			return nil
		}
	}
	if err := sc.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			return ErrLineTooLong
		}
		return &UnreachableError{Err: err}
	}
	return nil
}

func apiError(resp *http.Response) error {
	data, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody+1))
	msg := strings.TrimSpace(string(data))
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(data, &e) == nil && e.Error != "" {
		msg = e.Error
	}
	return &APIError{StatusCode: resp.StatusCode, Message: fmt.Sprintf("%d %s", resp.StatusCode, truncate(msg, maxErrorBody))}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
