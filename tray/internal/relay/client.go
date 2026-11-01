package relay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// State of the relay connection.
type State int

const (
	// StateOffline means no connection (initial, or between attempts).
	StateOffline State = iota
	// StateConnecting means a dial/hello is in progress.
	StateConnecting
	// StateConnected means welcome was received.
	StateConnected
)

func (s State) String() string {
	switch s {
	case StateConnecting:
		return "connecting"
	case StateConnected:
		return "connected"
	default:
		return "offline"
	}
}

var (
	// ErrNotConnected is returned by Send* when there is no live connection.
	ErrNotConnected = errors.New("relay: not connected")
	// ErrFrameTooLarge is returned when an outbound frame exceeds the relay limit.
	ErrFrameTooLarge = errors.New("relay: frame too large")
	errProtocol      = errors.New("relay: protocol violation")
)

// Handlers receive every S→D frame. Nil handlers are ignored. They are invoked from the read
// loop and must not block for long.
type Handlers struct {
	OnConnected     func(w Welcome)
	OnDisconnected  func(code int, err error)
	OnPairReady     func(claim, expiresAt string)
	OnPairJoined    func()
	OnPairMsg       func(payload json.RawMessage)
	OnPaired        func(deviceID, deviceToken string)
	OnPairAborted   func(reason string)
	OnSessionOpen   func(clientID string)
	OnSessionClosed func(clientID, reason string)
	OnData          func(clientID, deviceID string, payload json.RawMessage)
	OnRevoked       func(reason string)
	// OnUnauthorized is called on close 4001 (or HTTP 401/403 at dial): the caller must forget
	// the device token; the client reconnects unpaired.
	OnUnauthorized func()
	// OnReplaced is called on close 4006.
	OnReplaced func()
	OnError    func(code, message string)
}

// Config of a Client.
type Config struct {
	// ServerURL is http(s)://host[:port][/base]; converted to ws(s)://host/base/ws/device.
	ServerURL string
	// Token returns the current device token; "" means unpaired (no Authorization header).
	Token func() string
	// Version / Platform go into hello.
	Version  string
	Platform string
	Logger   *slog.Logger
	Handlers Handlers

	// Tunables (zero = SPEC defaults).
	PingInterval time.Duration // 30 s
	PongTimeout  time.Duration // 45 s
	BackoffBase  time.Duration // 1 s
	BackoffMax   time.Duration // 60 s
	StableAfter  time.Duration // 60 s
	DialTimeout  time.Duration // 15 s
	HTTPClient   *http.Client
}

// Client is the outbound relay connection with automatic reconnection.
type Client struct {
	cfg Config
	url string
	log *slog.Logger

	mu       sync.Mutex
	conn     *websocket.Conn
	state    State
	deviceID string
	maxFrame int
	lastPong time.Time

	reconnectCh chan struct{}
}

// New validates the configuration and builds the WebSocket URL.
func New(cfg Config) (*Client, error) {
	u, err := DeviceURL(cfg.ServerURL)
	if err != nil {
		return nil, err
	}
	if cfg.Token == nil {
		cfg.Token = func() string { return "" }
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	def := func(d *time.Duration, v time.Duration) {
		if *d == 0 {
			*d = v
		}
	}
	def(&cfg.PingInterval, 30*time.Second)
	def(&cfg.PongTimeout, 45*time.Second)
	def(&cfg.BackoffBase, time.Second)
	def(&cfg.BackoffMax, 60*time.Second)
	def(&cfg.StableAfter, 60*time.Second)
	def(&cfg.DialTimeout, 15*time.Second)
	if cfg.Platform == "" {
		cfg.Platform = "linux"
	}
	return &Client{cfg: cfg, url: u, log: cfg.Logger, maxFrame: DefaultMaxFrameBytes, reconnectCh: make(chan struct{}, 1)}, nil
}

// DeviceURL converts the server URL into the device WebSocket endpoint.
func DeviceURL(serverURL string) (string, error) {
	if serverURL == "" {
		return "", errors.New("relay: server URL is empty")
	}
	u, err := url.Parse(serverURL)
	if err != nil {
		return "", fmt.Errorf("relay: bad server URL: %w", err)
	}
	switch u.Scheme {
	case "http", "ws":
		u.Scheme = "ws"
	case "https", "wss":
		u.Scheme = "wss"
	default:
		return "", fmt.Errorf("relay: unsupported scheme %q", u.Scheme)
	}
	if u.Host == "" {
		return "", errors.New("relay: server URL has no host")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/ws/device"
	u.RawQuery, u.Fragment, u.User = "", "", nil
	return u.String(), nil
}

// State returns the connection state and the device_id reported by welcome ("" if unpaired).
func (c *Client) State() (State, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state, c.deviceID
}

// Reconnect drops the current connection (if any); Run reconnects with backoff.
func (c *Client) Reconnect() {
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "reconnect")
	}
	select {
	case c.reconnectCh <- struct{}{}:
	default:
	}
}

// Run connects and keeps reconnecting until ctx is done.
func (c *Client) Run(ctx context.Context) error {
	attempt := 0
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		started := time.Now()
		err := c.runOnce(ctx)
		code := websocket.CloseStatus(err)
		var he *httpStatusError
		if errors.As(err, &he) && (he.code == http.StatusUnauthorized || he.code == http.StatusForbidden) {
			code = CloseUnauthorized
		}
		c.setState(StateOffline, "")
		if ctx.Err() != nil {
			if c.cfg.Handlers.OnDisconnected != nil {
				c.cfg.Handlers.OnDisconnected(int(code), err)
			}
			return ctx.Err()
		}
		c.log.Info("relay disconnected", "code", int(code), "err", err)
		switch code {
		case CloseUnauthorized:
			if c.cfg.Handlers.OnUnauthorized != nil {
				c.cfg.Handlers.OnUnauthorized()
			}
		case CloseReplaced:
			if c.cfg.Handlers.OnReplaced != nil {
				c.cfg.Handlers.OnReplaced()
			}
		}
		if c.cfg.Handlers.OnDisconnected != nil {
			c.cfg.Handlers.OnDisconnected(int(code), err)
		}
		if time.Since(started) >= c.cfg.StableAfter {
			attempt = 0
		}
		delay := c.backoff(attempt)
		if code == CloseReplaced {
			// Another connection of this device took over; do not fight it.
			delay = c.cfg.BackoffMax
		}
		attempt++
		c.log.Debug("relay reconnecting", "in", delay.Round(time.Millisecond), "attempt", attempt)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		case <-c.reconnectCh:
		}
	}
}

// backoff returns a full-jitter delay: uniform in [0, min(max, base·2^attempt)].
func (c *Client) backoff(attempt int) time.Duration {
	capD := c.cfg.BackoffMax
	if attempt < 20 {
		if d := c.cfg.BackoffBase << uint(attempt); d < capD {
			capD = d
		}
	}
	if capD <= 0 {
		return 0
	}
	return time.Duration(rand.Int64N(int64(capD))) //nolint:gosec // jitter, not a secret
}

type httpStatusError struct{ code int }

func (e *httpStatusError) Error() string { return fmt.Sprintf("relay: handshake HTTP %d", e.code) }

func (c *Client) runOnce(ctx context.Context) error {
	c.setState(StateConnecting, "")
	headers := http.Header{}
	if tok := c.cfg.Token(); tok != "" {
		headers.Set("Authorization", "Bearer "+tok)
	}
	dialCtx, cancel := context.WithTimeout(ctx, c.cfg.DialTimeout)
	conn, resp, err := websocket.Dial(dialCtx, c.url, &websocket.DialOptions{
		Subprotocols: []string{Subprotocol},
		HTTPHeader:   headers,
		HTTPClient:   c.cfg.HTTPClient,
	})
	cancel()
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		if resp != nil && resp.StatusCode != http.StatusSwitchingProtocols {
			return &httpStatusError{code: resp.StatusCode}
		}
		return err
	}
	if conn.Subprotocol() != Subprotocol {
		_ = conn.Close(websocket.StatusProtocolError, "subprotocol")
		return fmt.Errorf("%w: server did not accept subprotocol %s", errProtocol, Subprotocol)
	}
	conn.SetReadLimit(int64(c.maxFrame))
	c.mu.Lock()
	c.conn = conn
	c.lastPong = time.Now()
	c.mu.Unlock()
	defer func() {
		_ = conn.CloseNow()
		c.mu.Lock()
		if c.conn == conn {
			c.conn = nil
		}
		c.mu.Unlock()
	}()

	hello := helloFrame{Type: "hello", V: ProtocolVersion, App: "tray", Version: c.cfg.Version,
		Platform: c.cfg.Platform, ProtocolVersions: []int{ProtocolVersion}}
	if err := c.write(ctx, conn, hello); err != nil {
		return err
	}
	// First frame must be welcome (an error frame is reported and treated as failure).
	first, err := c.readFrame(ctx, conn)
	if err != nil {
		return err
	}
	if first.Type == "error" {
		c.log.Warn("relay error before welcome", "code", first.Code, "message", first.Message)
		if c.cfg.Handlers.OnError != nil {
			c.cfg.Handlers.OnError(first.Code, first.Message)
		}
		// Keep reading until the server closes so the close code is observed.
		_, err := c.readFrame(ctx, conn)
		return err
	}
	if first.Type != "welcome" {
		return fmt.Errorf("%w: expected welcome, got %q", errProtocol, first.Type)
	}
	w := Welcome{V: first.V, DeviceID: first.DeviceID, Latest: first.Latest}
	if first.Limits != nil {
		w.Limits = *first.Limits
	}
	if w.Limits.MaxFrameBytes > 0 {
		c.mu.Lock()
		c.maxFrame = w.Limits.MaxFrameBytes
		c.mu.Unlock()
		conn.SetReadLimit(int64(w.Limits.MaxFrameBytes))
	}
	did := ""
	if w.DeviceID != nil {
		did = *w.DeviceID
	}
	c.setState(StateConnected, did)
	c.log.Info("relay connected", "device_id", did, "paired", did != "")
	if c.cfg.Handlers.OnConnected != nil {
		c.cfg.Handlers.OnConnected(w)
	}

	pingCtx, stopPing := context.WithCancel(ctx)
	pingDone := make(chan error, 1)
	go func() { pingDone <- c.pinger(pingCtx, conn) }()
	defer stopPing()

	readErr := make(chan error, 1)
	go func() {
		for {
			f, err := c.readFrame(ctx, conn)
			if err != nil {
				readErr <- err
				return
			}
			c.dispatch(ctx, conn, f)
		}
	}()
	select {
	case err := <-readErr:
		return err
	case err := <-pingDone:
		_ = conn.Close(websocket.StatusGoingAway, "keepalive")
		return err
	}
}

func (c *Client) pinger(ctx context.Context, conn *websocket.Conn) error {
	t := time.NewTicker(c.cfg.PingInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			c.mu.Lock()
			silent := time.Since(c.lastPong)
			c.mu.Unlock()
			if silent > c.cfg.PongTimeout {
				return fmt.Errorf("relay: no pong for %s", silent.Round(time.Second))
			}
			if err := c.write(ctx, conn, pingFrame{Type: "ping", T: time.Now().UnixMilli()}); err != nil {
				return err
			}
		}
	}
}

func (c *Client) readFrame(ctx context.Context, conn *websocket.Conn) (*inFrame, error) {
	typ, data, err := conn.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageText {
		return nil, fmt.Errorf("%w: binary frame", errProtocol)
	}
	var f inFrame
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("%w: bad JSON: %v", errProtocol, err)
	}
	return &f, nil
}

func (c *Client) dispatch(ctx context.Context, conn *websocket.Conn, f *inFrame) {
	h := c.cfg.Handlers
	c.log.Debug("relay frame", "type", f.Type)
	switch f.Type {
	case "ping":
		_ = c.write(ctx, conn, pingFrame{Type: "pong", T: f.T})
	case "pong":
		c.mu.Lock()
		c.lastPong = time.Now()
		c.mu.Unlock()
	case "pair_ready":
		if h.OnPairReady != nil {
			h.OnPairReady(f.Claim, f.ExpiresAt)
		}
	case "pair_joined":
		if h.OnPairJoined != nil {
			h.OnPairJoined()
		}
	case "pair_msg":
		if h.OnPairMsg != nil {
			h.OnPairMsg(f.Payload)
		}
	case "paired":
		did := ""
		if f.DeviceID != nil {
			did = *f.DeviceID
		}
		c.setState(StateConnected, did)
		if h.OnPaired != nil {
			h.OnPaired(did, f.DeviceToken)
		}
	case "pair_aborted":
		if h.OnPairAborted != nil {
			h.OnPairAborted(f.Reason)
		}
	case "session_open":
		if h.OnSessionOpen != nil {
			h.OnSessionOpen(f.ClientID)
		}
	case "session_closed":
		if h.OnSessionClosed != nil {
			h.OnSessionClosed(f.ClientID, f.Reason)
		}
	case "data":
		did := ""
		if f.DeviceID != nil {
			did = *f.DeviceID
		}
		if h.OnData != nil {
			h.OnData(f.ClientID, did, f.Payload)
		}
	case "revoked":
		c.log.Warn("device revoked", "reason", f.Reason)
		if h.OnRevoked != nil {
			h.OnRevoked(f.Reason)
		}
	case "error":
		c.log.Warn("relay error", "code", f.Code, "message", f.Message)
		if h.OnError != nil {
			h.OnError(f.Code, f.Message)
		}
	case "welcome":
		// Duplicate welcome: ignore.
	default:
		c.log.Warn("relay: unknown frame type dropped", "type", f.Type)
	}
}

func (c *Client) setState(s State, deviceID string) {
	c.mu.Lock()
	c.state = s
	c.deviceID = deviceID
	c.mu.Unlock()
}

// write marshals and sends one frame on conn.
func (c *Client) write(ctx context.Context, conn *websocket.Conn, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.mu.Lock()
	limit := c.maxFrame
	c.mu.Unlock()
	if len(data) > limit {
		return ErrFrameTooLarge
	}
	wctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return conn.Write(wctx, websocket.MessageText, data)
}

// send writes on the current connection, if any.
func (c *Client) send(v any) error {
	c.mu.Lock()
	conn := c.conn
	st := c.state
	c.mu.Unlock()
	if conn == nil || st != StateConnected {
		return ErrNotConnected
	}
	return c.write(context.Background(), conn, v)
}

// SendPairStart asks the relay for a pairing session.
func (c *Client) SendPairStart() error { return c.send(pairStartFrame{Type: "pair_start"}) }

// SendPairMsg forwards an opaque SPAKE2 payload to the joined browser.
func (c *Client) SendPairMsg(payload json.RawMessage) error {
	return c.send(pairMsgFrame{Type: "pair_msg", Payload: payload})
}

// SendPairDone reports the pairing result (only the device decides).
func (c *Client) SendPairDone(ok bool, name string) error {
	return c.send(pairDoneFrame{Type: "pair_done", OK: ok, Name: name})
}

// SendData sends a payload to the client of an open session.
func (c *Client) SendData(clientID string, payload json.RawMessage) error {
	return c.send(dataFrame{Type: "data", ClientID: clientID, Payload: payload})
}

// SendClose asks the relay to close the session with clientID.
func (c *Client) SendClose(clientID string) error {
	return c.send(closeFrame{Type: "close", ClientID: clientID})
}

// MaxFrameBytes is the current relay frame limit.
func (c *Client) MaxFrameBytes() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.maxFrame
}
