package localui

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

// Settings is what the settings page edits (a subset of config.Config).
type Settings struct {
	ServerURL  string
	OllamaURL  string
	DeviceName string
	Autostart  bool
}

// Status is the live state shown on the index page.
type Status struct {
	Ollama        string
	OllamaVersion string
	Relay         string
	Paired        bool
}

// Hooks connect the pages to the app. Every hook may be nil (the feature is then hidden).
type Hooks struct {
	GetSettings func() Settings
	// SaveSettings persists and applies; restartNeeded=true shows the "quit and reopen" notice.
	SaveSettings func(Settings) (restartNeeded bool, err error)
	// PairURL builds the deep link the QR encodes: <server>/pair#<code without dashes>.
	PairURL func(code string) string
	// StartPairing generates a new code (same as the menu item).
	StartPairing  func() error
	CancelPairing func()
	OpenConfigDir func() error
}

// Server is the loopback HTTP server. Zero value is not usable; use New.
type Server struct {
	hooks Hooks
	lang  Lang
	token string

	mu      sync.Mutex
	ln      net.Listener
	srv     *http.Server
	code    string
	expires time.Time
	status  Status
	tpl     *template.Template
}

// New creates the server; nothing listens until URL/Start is called.
func New(hooks Hooks, lang Lang) *Server {
	tok := make([]byte, 24)
	_, _ = rand.Read(tok)
	return &Server{hooks: hooks, lang: lang, token: hex.EncodeToString(tok), tpl: template.Must(template.New("ui").Parse(pageTemplate))}
}

// Start binds 127.0.0.1 on a random port (idempotent) and returns the base URL.
func (s *Server) Start() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ln != nil {
		return "http://" + s.ln.Addr().String(), nil
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.guard(s.handleIndex))
	mux.HandleFunc("/pair", s.guard(s.handlePair))
	mux.HandleFunc("/pair/new", s.guard(s.handlePairNew))
	mux.HandleFunc("/pair/cancel", s.guard(s.handlePairCancel))
	mux.HandleFunc("/settings", s.guard(s.handleSettings))
	mux.HandleFunc("/settings/folder", s.guard(s.handleFolder))
	s.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	s.ln = ln
	go func() { _ = s.srv.Serve(ln) }()
	return "http://" + ln.Addr().String(), nil
}

// URL returns the tokenised URL of a page, starting the server if needed.
func (s *Server) URL(path string) (string, error) {
	base, err := s.Start()
	if err != nil {
		return "", err
	}
	return base + path + "?t=" + s.token, nil
}

// Close stops listening.
func (s *Server) Close() {
	s.mu.Lock()
	srv, ln := s.srv, s.ln
	s.srv, s.ln = nil, nil
	s.mu.Unlock()
	if srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}
	if ln != nil {
		_ = ln.Close()
	}
}

// SetPairing publishes the current code; ClearPairing removes it.
func (s *Server) SetPairing(code string, expires time.Time) {
	s.mu.Lock()
	s.code, s.expires = code, expires
	s.mu.Unlock()
}

func (s *Server) ClearPairing() { s.SetPairing("", time.Time{}) }

// SetStatus updates the index page.
func (s *Server) SetStatus(st Status) {
	s.mu.Lock()
	s.status = st
	s.mu.Unlock()
}

// guard enforces the token (query `t` or form field) and same-origin for POST.
func (s *Server) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := r.URL.Query().Get("t")
		if tok == "" && r.Method == http.MethodPost {
			tok = r.FormValue("t")
		}
		if subtle.ConstantTimeCompare([]byte(tok), []byte(s.token)) != 1 {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodPost {
			if o := r.Header.Get("Origin"); o != "" {
				if u, err := url.Parse(o); err != nil || u.Host != r.Host {
					http.Error(w, "forbidden", http.StatusForbidden)
					return
				}
			}
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'")
		next(w, r)
	}
}

type page struct {
	Lang      Lang
	Token     string
	Active    string
	Title     string
	Notice    string
	Error     string
	Status    Status
	Code      string
	ExpiresIn int // seconds; 0 = none
	QR        template.URL
	OpenHere  string
	Settings  Settings
	Folder    bool
}

func (s *Server) base(active string) page {
	s.mu.Lock()
	defer s.mu.Unlock()
	return page{Lang: s.lang, Token: s.token, Active: active, Status: s.status, Title: T(s.lang, "app")}
}

func (s *Server) render(w http.ResponseWriter, p page) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := s.tpl.Execute(w, map[string]any{"P": p, "T": func(k string) string { return T(p.Lang, k) }}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	s.render(w, s.base("status"))
}

func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	p := s.base("pair")
	s.mu.Lock()
	code, exp := s.code, s.expires
	s.mu.Unlock()
	if code != "" {
		p.Code = code
		if d := time.Until(exp); d > 0 {
			p.ExpiresIn = int(d.Seconds())
		} else {
			p.Code = ""
			p.Error = T(s.lang, "pair.expired")
		}
	}
	if p.Code != "" && s.hooks.PairURL != nil {
		link := s.hooks.PairURL(p.Code)
		p.OpenHere = link
		if png, err := qrcode.Encode(link, qrcode.Medium, 360); err == nil {
			p.QR = template.URL("data:image/png;base64," + base64.StdEncoding.EncodeToString(png)) //nolint:gosec // data URL we built
		}
	}
	s.render(w, p)
}

func (s *Server) handlePairNew(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	if s.hooks.StartPairing != nil {
		if err := s.hooks.StartPairing(); err != nil && !errors.Is(err, errBusy) {
			p := s.base("pair")
			p.Error = fmt.Sprintf("%s %v", T(s.lang, "err"), err)
			s.render(w, p)
			return
		}
	}
	// The code arrives asynchronously (pair_ready); give it a moment before rendering.
	for i := 0; i < 40; i++ {
		s.mu.Lock()
		got := s.code != ""
		s.mu.Unlock()
		if got {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	http.Redirect(w, r, "/pair?t="+s.token, http.StatusSeeOther)
}

var errBusy = errors.New("pairing: busy")

func (s *Server) handlePairCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost && s.hooks.CancelPairing != nil {
		s.hooks.CancelPairing()
	}
	http.Redirect(w, r, "/pair?t="+s.token, http.StatusSeeOther)
}

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	p := s.base("settings")
	p.Folder = s.hooks.OpenConfigDir != nil
	if s.hooks.GetSettings == nil {
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodPost {
		st := Settings{
			ServerURL:  strings.TrimSpace(r.FormValue("server_url")),
			OllamaURL:  strings.TrimSpace(r.FormValue("ollama_url")),
			DeviceName: strings.TrimSpace(r.FormValue("device_name")),
			Autostart:  r.FormValue("autostart") == "on",
		}
		if s.hooks.SaveSettings != nil {
			restart, err := s.hooks.SaveSettings(st)
			switch {
			case err != nil:
				p.Error = fmt.Sprintf("%s %v", T(s.lang, "err"), err)
			case restart:
				p.Notice = T(s.lang, "settings.restart")
			default:
				p.Notice = T(s.lang, "settings.saved")
			}
		}
	}
	p.Settings = s.hooks.GetSettings()
	s.render(w, p)
}

func (s *Server) handleFolder(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost && s.hooks.OpenConfigDir != nil {
		_ = s.hooks.OpenConfigDir()
	}
	http.Redirect(w, r, "/settings?t="+s.token, http.StatusSeeOther)
}
