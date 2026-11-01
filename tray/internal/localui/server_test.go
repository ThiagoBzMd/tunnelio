package localui

import (
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func get(t *testing.T, u string) (int, string) {
	t.Helper()
	res, err := http.Get(u) //nolint:gosec // loopback test URL
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func TestTokenRequiredAndPairPage(t *testing.T) {
	var started, cancelled int
	s := New(Hooks{
		PairURL:       func(code string) string { return "https://app.example.com/pair#" + strings.ReplaceAll(code, "-", "") },
		StartPairing:  func() error { started++; return nil },
		CancelPairing: func() { cancelled++ },
		GetSettings: func() Settings {
			return Settings{ServerURL: "https://app.example.com", OllamaURL: "http://127.0.0.1:11434", DeviceName: "pc"}
		},
		SaveSettings: func(st Settings) (bool, error) { return st.ServerURL != "https://app.example.com", nil },
	}, LangPTBR)
	defer s.Close()
	base, err := s.Start()
	if err != nil {
		t.Fatal(err)
	}
	if code, _ := get(t, base+"/pair"); code != http.StatusNotFound {
		t.Fatalf("no token → want 404, got %d", code)
	}
	if code, _ := get(t, base+"/pair?t=wrong"); code != http.StatusNotFound {
		t.Fatalf("wrong token → want 404, got %d", code)
	}
	u, _ := s.URL("/pair")
	code, body := get(t, u)
	if code != 200 || !strings.Contains(body, "Nenhum pareamento") {
		t.Fatalf("idle pair page: %d %q", code, body[:min(len(body), 200)])
	}
	s.SetPairing("K7M3-ABCD-EFGH", time.Now().Add(4*time.Minute))
	_, body = get(t, u)
	for _, want := range []string{"K7M3-ABCD-EFGH", "data:image/png;base64,", "https://app.example.com/pair#K7M3ABCDEFGH", "Expira em", "Parear este dispositivo"} {
		if !strings.Contains(body, want) {
			t.Fatalf("pair page missing %q", want)
		}
	}
	// expired code is not shown
	s.SetPairing("K7M3-ABCD-EFGH", time.Now().Add(-time.Second))
	_, body = get(t, u)
	if strings.Contains(body, "K7M3-ABCD-EFGH") || !strings.Contains(body, "expirou") {
		t.Fatalf("expired code still shown")
	}
	// POST actions need the token in the form and call the hooks
	res, err := http.PostForm(base+"/pair/new", url.Values{"t": {s.token}}) //nolint:gosec
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	res, _ = http.PostForm(base+"/pair/cancel", url.Values{"t": {s.token}}) //nolint:gosec
	_ = res.Body.Close()
	if started != 1 || cancelled != 1 {
		t.Fatalf("hooks: started=%d cancelled=%d", started, cancelled)
	}
	res, _ = http.PostForm(base+"/pair/new", url.Values{"t": {"nope"}}) //nolint:gosec
	_ = res.Body.Close()
	if started != 1 {
		t.Fatalf("POST without token must be rejected")
	}
}

func TestSettingsPage(t *testing.T) {
	saved := Settings{}
	s := New(Hooks{
		GetSettings:  func() Settings { return saved },
		SaveSettings: func(st Settings) (bool, error) { saved = st; return true, nil },
	}, LangEN)
	defer s.Close()
	u, _ := s.URL("/settings")
	code, body := get(t, u)
	if code != 200 || !strings.Contains(body, "Server address") || !strings.Contains(body, "Start Tunnelio when I log in") {
		t.Fatalf("settings page: %d", code)
	}
	// The AGPL-3.0 notices: licence, no warranty, the third-party licences and where the source is.
	for _, want := range []string{"GNU AGPL-3.0-only", "no warranty", "THIRD_PARTY_LICENSES.txt", `href="https://github.com/ThiagoBzMd/tunnelio/blob/main/LICENSE"`, `href="https://github.com/ThiagoBzMd/tunnelio"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("legal notice missing %q", want)
		}
	}
	res, err := http.PostForm(strings.Split(u, "?")[0], url.Values{"t": {s.token}, "server_url": {"https://self.example.org"}, "ollama_url": {"http://127.0.0.1:11434"}, "device_name": {"Desk"}, "autostart": {"on"}}) //nolint:gosec
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if saved.ServerURL != "https://self.example.org" || !saved.Autostart || saved.DeviceName != "Desk" {
		t.Fatalf("not saved: %+v", saved)
	}
	if !strings.Contains(string(b), "Quit and reopen") {
		t.Fatalf("restart notice missing")
	}
	// cross-origin POST is refused
	req, _ := http.NewRequest(http.MethodPost, strings.Split(u, "?")[0], strings.NewReader("t="+s.token+"&server_url=x"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "https://evil.example")
	res, _ = http.DefaultClient.Do(req)
	_ = res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin POST: want 403, got %d", res.StatusCode)
	}
}

func TestDetectLang(t *testing.T) {
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_MESSAGES", "")
	t.Setenv("LANGUAGE", "")
	t.Setenv("LANG", "pt_BR.UTF-8")
	if DetectLang() != LangPTBR {
		t.Fatal("pt_BR → pt-BR")
	}
	t.Setenv("LANG", "en_US.UTF-8")
	if DetectLang() != LangEN {
		t.Fatal("en_US → en")
	}
	t.Setenv("LANG", "C")
	if DetectLang() != LangEN {
		t.Fatal("C → en")
	}
}
