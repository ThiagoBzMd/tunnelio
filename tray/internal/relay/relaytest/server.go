// Package relaytest is an in-process fake of the relay's device endpoint (SPEC §3.4) for tests:
// hello/welcome, bearer auth, pairing (pair_start → claim, a fake browser that exchanges
// pair_msg), sessions (session_open/data/close) and ping/pong. It is deliberately small and
// permissive; it is not the reference relay.
package relaytest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Frame is one frame received from the device.
type Frame struct {
	Type string
	Raw  map[string]json.RawMessage
}

// String returns a field as a string ("" if absent or not a string).
func (f Frame) String(key string) string {
	var s string
	_ = json.Unmarshal(f.Raw[key], &s)
	return s
}

// Bool returns a field as a bool.
func (f Frame) Bool(key string) bool {
	var b bool
	_ = json.Unmarshal(f.Raw[key], &b)
	return b
}

// Browser is the fake client side of one pairing session.
type Browser struct {
	Claim string
	in    chan json.RawMessage
	res   chan Frame
}

// SendPairMsg sends pair_msg{payload} to the device.
func (b *Browser) SendPairMsg(s *Server, payload any) {
	s.Send(map[string]any{"type": "pair_msg", "payload": payload})
}

// NextPairMsg waits for the next pair_msg payload from the device.
func (b *Browser) NextPairMsg(timeout time.Duration) (json.RawMessage, bool) {
	select {
	case p := <-b.in:
		return p, true
	case <-time.After(timeout):
		return nil, false
	}
}

// Result waits for the pair_done frame from the device.
func (b *Browser) Result(timeout time.Duration) (Frame, bool) {
	select {
	case f := <-b.res:
		return f, true
	case <-time.After(timeout):
		return Frame{}, false
	}
}

// Session is one client_id × device session seen from the fake relay.
type Session struct {
	ClientID string
	in       chan json.RawMessage
	closed   chan string
}

// Next waits for the next data payload sent by the device to this client.
func (s *Session) Next(timeout time.Duration) (json.RawMessage, bool) {
	select {
	case p := <-s.in:
		return p, true
	case <-time.After(timeout):
		return nil, false
	}
}

// Closed waits for the device to close this session (reason returned).
func (s *Session) Closed(timeout time.Duration) (string, bool) {
	select {
	case r := <-s.closed:
		return r, true
	case <-time.After(timeout):
		return "", false
	}
}

// Server is the fake relay.
type Server struct {
	*httptest.Server

	mu       sync.Mutex
	conn     *websocket.Conn
	connCtx  context.Context
	authed   bool
	deviceID string
	token    string
	claimN   int
	browsers map[string]*Browser
	sessions map[string]*Session

	// Frames receives every frame from the device (buffered).
	Frames chan Frame
	// Connected is signaled on every completed hello/welcome.
	Connected chan Frame
	// Headers of the last upgrade request (Authorization etc.).
	lastHeaders http.Header
	// MaxFrameBytes announced in welcome.
	MaxFrameBytes int
	// RejectToken, when set, closes every authenticated connection with 4001 (revoked token).
	RejectToken bool
	mutePongs   bool
}

// New starts a fake relay. deviceID/token may be empty (no device registered yet).
func New(deviceID, token string) *Server {
	s := &Server{
		deviceID:      deviceID,
		token:         token,
		browsers:      map[string]*Browser{},
		sessions:      map[string]*Session{},
		Frames:        make(chan Frame, 1024),
		Connected:     make(chan Frame, 16),
		MaxFrameBytes: 1 << 20,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/device", s.handle)
	s.Server = httptest.NewServer(mux)
	return s
}

// Device returns the registered device_id and token (set after a successful first pairing).
func (s *Server) Device() (string, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deviceID, s.token
}

// LastHeaders returns the headers of the latest upgrade request.
func (s *Server) LastHeaders() http.Header {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastHeaders.Clone()
}

// IsConnected reports whether a device connection is live.
func (s *Server) IsConnected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn != nil
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.lastHeaders = r.Header.Clone()
	s.mu.Unlock()
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"tunnelio.v1"}, InsecureSkipVerify: true})
	if err != nil {
		return
	}
	if conn.Subprotocol() != "tunnelio.v1" {
		_ = conn.Close(4002, "subprotocol")
		return
	}
	conn.SetReadLimit(int64(s.MaxFrameBytes))
	ctx := r.Context()

	authed := false
	if auth := r.Header.Get("Authorization"); auth != "" {
		s.mu.Lock()
		ok := strings.HasPrefix(auth, "Bearer ") && s.token != "" && auth == "Bearer "+s.token && !s.RejectToken
		s.mu.Unlock()
		if !ok {
			_ = conn.Close(4001, "unauthorized")
			return
		}
		authed = true
	}

	s.mu.Lock()
	old := s.conn
	s.conn, s.connCtx, s.authed = conn, ctx, authed
	s.mu.Unlock()
	if old != nil {
		_ = old.Close(4006, "replaced")
	}
	defer func() {
		s.mu.Lock()
		if s.conn == conn {
			s.conn = nil
			s.authed = false
		}
		s.mu.Unlock()
		_ = conn.CloseNow()
	}()

	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			_ = conn.Close(4002, "binary")
			return
		}
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(data, &raw); err != nil {
			_ = conn.Close(4002, "json")
			return
		}
		f := Frame{Raw: raw}
		_ = json.Unmarshal(raw["type"], &f.Type)
		select {
		case s.Frames <- f:
		default:
		}
		if !s.dispatch(conn, f) {
			return
		}
	}
}

// dispatch handles one device frame; returns false to end the connection.
func (s *Server) dispatch(conn *websocket.Conn, f Frame) bool {
	switch f.Type {
	case "hello":
		s.mu.Lock()
		var did any
		if s.authed {
			did = s.deviceID
		}
		s.mu.Unlock()
		s.Send(map[string]any{"type": "welcome", "v": 1, "device_id": did,
			"limits": map[string]any{"max_frame_bytes": s.MaxFrameBytes}})
		select {
		case s.Connected <- f:
		default:
		}
	case "ping":
		s.mu.Lock()
		mute := s.mutePongs
		s.mu.Unlock()
		if !mute {
			s.Send(map[string]any{"type": "pong", "t": json.RawMessage(f.Raw["t"])})
		}
	case "pong":
	case "pair_start":
		s.mu.Lock()
		s.claimN++
		claim := fmt.Sprintf("%04d", s.claimN)
		s.browsers[claim] = &Browser{Claim: claim, in: make(chan json.RawMessage, 16), res: make(chan Frame, 1)}
		s.mu.Unlock()
		s.Send(map[string]any{"type": "pair_ready", "claim": claim,
			"expires_at": time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339)})
	case "pair_msg":
		if b := s.currentBrowser(); b != nil {
			b.in <- f.Raw["payload"]
		}
	case "pair_done":
		b := s.currentBrowser()
		if f.Bool("ok") {
			s.mu.Lock()
			if s.deviceID == "" {
				s.deviceID, s.token = newUUID(), randomHex(32)
				s.authed = true
				did, tok := s.deviceID, s.token
				s.mu.Unlock()
				s.Send(map[string]any{"type": "paired", "device_id": did, "device_token": tok})
			} else {
				s.mu.Unlock()
			}
		}
		if b != nil {
			b.res <- f
		}
	case "data":
		s.mu.Lock()
		sess := s.sessions[f.String("client_id")]
		s.mu.Unlock()
		if sess != nil {
			sess.in <- f.Raw["payload"]
		} else {
			s.Send(map[string]any{"type": "error", "code": "E_NO_SESSION"})
		}
	case "close":
		cid := f.String("client_id")
		s.mu.Lock()
		sess := s.sessions[cid]
		delete(s.sessions, cid)
		s.mu.Unlock()
		if sess != nil {
			s.Send(map[string]any{"type": "session_closed", "client_id": cid, "reason": "device"})
			select {
			case sess.closed <- "device":
			default:
			}
		}
	default:
		_ = conn.Close(4002, "unknown type "+f.Type)
		return false
	}
	return true
}

func (s *Server) currentBrowser() *Browser {
	s.mu.Lock()
	defer s.mu.Unlock()
	claim := fmt.Sprintf("%04d", s.claimN)
	return s.browsers[claim]
}

// Send writes a frame to the device (no-op when disconnected).
func (s *Server) Send(v any) {
	s.mu.Lock()
	conn, ctx := s.conn, s.connCtx
	s.mu.Unlock()
	if conn == nil {
		return
	}
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_ = conn.Write(wctx, websocket.MessageText, data)
}

// WaitFrame waits for the next device frame of the given type.
func (s *Server) WaitFrame(typ string, timeout time.Duration) (Frame, bool) {
	deadline := time.After(timeout)
	for {
		select {
		case f := <-s.Frames:
			if f.Type == typ {
				return f, true
			}
		case <-deadline:
			return Frame{}, false
		}
	}
}

// WaitConnected waits for a hello (connection established).
func (s *Server) WaitConnected(timeout time.Duration) bool {
	select {
	case <-s.Connected:
		return true
	case <-time.After(timeout):
		return false
	}
}

// Join simulates a browser entering the pairing session for claim: sends pair_joined.
func (s *Server) Join(claim string) (*Browser, bool) {
	s.mu.Lock()
	b := s.browsers[claim]
	s.mu.Unlock()
	if b == nil {
		return nil, false
	}
	s.Send(map[string]any{"type": "pair_joined"})
	return b, true
}

// AbortPairing sends pair_aborted to the device.
func (s *Server) AbortPairing(reason string) {
	s.Send(map[string]any{"type": "pair_aborted", "reason": reason})
}

// OpenSession sends session_open{client_id} and returns the session handle.
func (s *Server) OpenSession(clientID string) *Session {
	sess := &Session{ClientID: clientID, in: make(chan json.RawMessage, 256), closed: make(chan string, 1)}
	s.mu.Lock()
	s.sessions[clientID] = sess
	s.mu.Unlock()
	s.Send(map[string]any{"type": "session_open", "client_id": clientID})
	return sess
}

// CloseSession sends session_closed to the device (browser went away).
func (s *Server) CloseSession(clientID, reason string) {
	s.mu.Lock()
	delete(s.sessions, clientID)
	s.mu.Unlock()
	s.Send(map[string]any{"type": "session_closed", "client_id": clientID, "reason": reason})
}

// SendData delivers data{client_id, device_id, payload} to the device.
func (s *Server) SendData(clientID string, payload any) {
	s.mu.Lock()
	did := s.deviceID
	s.mu.Unlock()
	s.Send(map[string]any{"type": "data", "client_id": clientID, "device_id": did, "payload": payload})
}

// Revoke sends revoked{reason} then closes with 4001 and forgets the device.
func (s *Server) Revoke(reason string) {
	s.Send(map[string]any{"type": "revoked", "reason": reason})
	s.mu.Lock()
	s.deviceID, s.token = "", ""
	conn := s.conn
	s.mu.Unlock()
	if conn != nil {
		_ = conn.Close(4001, reason)
	}
}

// MutePongs stops (or resumes) answering pings, to exercise dead-connection detection.
func (s *Server) MutePongs(mute bool) {
	s.mu.Lock()
	s.mutePongs = mute
	s.mu.Unlock()
}

// CloseDevice closes the current device connection with a code.
func (s *Server) CloseDevice(code int, reason string) {
	s.mu.Lock()
	conn := s.conn
	s.mu.Unlock()
	if conn != nil {
		_ = conn.Close(websocket.StatusCode(code), reason)
	}
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
