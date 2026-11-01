package channel

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/crypto"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/history"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/ollama"
)

const (
	// MaxMessageBytes is the plaintext limit of one application message (SPEC §7.6; raised
	// from 1 MiB to 8 MiB so that a user message can carry images).
	MaxMessageBytes = 8 << 20
	// MaxImagesPerMessage / MaxImageBytes are the per-message image limits (device_info.limits).
	MaxImagesPerMessage = ollama.MaxImagesPerMessage
	MaxImageBytes       = ollama.MaxImageBytes
	// RequestsPerMinute / RequestBurst is the per-session token bucket (SPEC §7.6).
	RequestsPerMinute = 60
	RequestBurst      = 20
	// DefaultChunkInterval is the minimum spacing of chat_chunk frames (SPEC §7.4).
	DefaultChunkInterval = 40 * time.Millisecond
	// DefaultPullInterval is the minimum spacing of pull_progress frames (≤ 2/s).
	DefaultPullInterval = 500 * time.Millisecond
	// requestTimeout bounds non-streaming Ollama calls.
	requestTimeout = 30 * time.Second
	// maxRequestID is the limit of a request id (SPEC §2).
	maxRequestID = 64
)

// Notifier shows a local notification (tray) or logs it (headless).
type Notifier interface {
	Notify(title, body string)
}

// Transport is the subset of the relay client used by the channel.
type Transport interface {
	SendData(clientID string, payload json.RawMessage) error
	SendClose(clientID string) error
}

// PairingLookup resolves pairing_id → PK (config.Pairings).
type PairingLookup interface {
	Lookup(pairingID []byte) ([]byte, bool)
}

// OllamaStatus is what device_info reports about the local Ollama.
type OllamaStatus struct {
	Status  string // running | stopped | not_installed
	Version string
}

// Config of a Manager.
type Config struct {
	Transport   Transport
	Pairings    PairingLookup
	Ollama      *ollama.Client
	History     *history.Store
	Notifier    Notifier
	Logger      *slog.Logger
	TrayVersion string
	Platform    string
	// OllamaStatus returns the current detection state (nil = unknown/stopped).
	OllamaStatus func() OllamaStatus
	// OnHandshake is called after mac_c is verified (device_info already queued).
	OnHandshake func(clientID string)

	// Tunables (zero = defaults).
	ChunkInterval     time.Duration
	PullInterval      time.Duration
	RequestsPerMinute int
	RequestBurst      int
	Now               func() time.Time
}

// Manager owns every E2E session of this device.
type Manager struct {
	cfg Config
	log *slog.Logger

	mu          sync.Mutex
	deviceID    string
	deviceIDRaw []byte
	sessions    map[string]*session
	chat        *activeChat
	pull        *activePull
}

type sessionState int

const (
	stInit sessionState = iota
	stAwaitConfirm
	stEstablished
)

// session is the per-client_id state (SPEC §5, §6).
type session struct {
	clientID string
	mu       sync.Mutex
	state    sessionState
	keys     *crypto.SessionKeys
	sendKey  *crypto.EnvelopeKey // k_d2c
	recvKey  *crypto.EnvelopeKey // k_c2d
	sendCtr  uint64
	recvCtr  uint64
	bucket   *tokenBucket
	closed   bool
}

// New creates a Manager.
func New(cfg Config) *Manager {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.ChunkInterval == 0 {
		cfg.ChunkInterval = DefaultChunkInterval
	}
	if cfg.PullInterval == 0 {
		cfg.PullInterval = DefaultPullInterval
	}
	if cfg.RequestsPerMinute == 0 {
		cfg.RequestsPerMinute = RequestsPerMinute
	}
	if cfg.RequestBurst == 0 {
		cfg.RequestBurst = RequestBurst
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Platform == "" {
		cfg.Platform = "linux"
	}
	if cfg.OllamaStatus == nil {
		cfg.OllamaStatus = func() OllamaStatus { return OllamaStatus{Status: "stopped"} }
	}
	if cfg.Notifier == nil {
		cfg.Notifier = logNotifier{cfg.Logger}
	}
	return &Manager{cfg: cfg, log: cfg.Logger, sessions: map[string]*session{}}
}

type logNotifier struct{ log *slog.Logger }

func (n logNotifier) Notify(title, body string) {
	n.log.Info("notification", "title", title, "body", body)
}

// SetDeviceID sets the device identity used in the envelope AAD. "" = unpaired.
func (m *Manager) SetDeviceID(id string) error {
	var raw []byte
	if id != "" {
		var err error
		raw, err = crypto.ParseDeviceID(id)
		if err != nil {
			return err
		}
	}
	m.mu.Lock()
	m.deviceID, m.deviceIDRaw = id, raw
	m.mu.Unlock()
	return nil
}

// DeviceID returns the current device id.
func (m *Manager) DeviceID() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.deviceID
}

// Sessions returns the number of open sessions.
func (m *Manager) Sessions() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessions)
}

// OnSessionOpen creates the session state for a client.
func (m *Manager) OnSessionOpen(clientID string) {
	m.mu.Lock()
	if old, ok := m.sessions[clientID]; ok {
		old.mu.Lock()
		old.closed = true
		old.mu.Unlock()
	}
	m.sessions[clientID] = &session{clientID: clientID, bucket: newTokenBucket(m.cfg.RequestsPerMinute, m.cfg.RequestBurst, m.cfg.Now)}
	m.mu.Unlock()
	m.log.Info("session opened", "client_id", clientID)
}

// OnSessionClosed discards a session (and aborts a chat owned by it; a pull goes on, rev. 1.9).
func (m *Manager) OnSessionClosed(clientID, reason string) {
	m.mu.Lock()
	s := m.sessions[clientID]
	delete(m.sessions, clientID)
	m.cancelOwnedLocked(s)
	m.mu.Unlock()
	if s != nil {
		s.mu.Lock()
		s.closed = true
		s.mu.Unlock()
	}
	m.log.Info("session closed", "client_id", clientID, "reason", reason)
}

// OnDisconnected discards every session (relay dropped; SPEC §3.7).
func (m *Manager) OnDisconnected() {
	m.mu.Lock()
	for id, s := range m.sessions {
		s.mu.Lock()
		s.closed = true
		s.mu.Unlock()
		m.cancelOwnedLocked(s)
		delete(m.sessions, id)
	}
	m.mu.Unlock()
}

func (m *Manager) cancelOwnedLocked(s *session) {
	if s == nil {
		return
	}
	if m.chat != nil && m.chat.session == s {
		m.chat.cancel()
	}
	if m.pull != nil {
		m.pull.dropSession(s) // the download goes on without this browser (SPEC §7.6)
	}
}

// CloseAll closes every session from the device side (pairings removed from the local menu).
func (m *Manager) CloseAll() {
	m.mu.Lock()
	list := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.mu.Unlock()
	for _, s := range list {
		m.closeSession(s, "local")
	}
}

// closeSession is the device-initiated close (counter violation, SPEC §6.3).
func (m *Manager) closeSession(s *session, reason string) {
	m.mu.Lock()
	if cur := m.sessions[s.clientID]; cur == s {
		delete(m.sessions, s.clientID)
	}
	m.cancelOwnedLocked(s)
	m.mu.Unlock()
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	m.log.Warn("closing session", "client_id", s.clientID, "reason", reason)
	if err := m.cfg.Transport.SendClose(s.clientID); err != nil {
		m.log.Debug("close not sent", "err", err)
	}
}

// OnData handles one data frame from the relay.
func (m *Manager) OnData(clientID, deviceID string, raw json.RawMessage) {
	m.mu.Lock()
	s := m.sessions[clientID]
	myID := m.deviceID
	m.mu.Unlock()
	if s == nil {
		m.log.Debug("data for unknown session dropped", "client_id", clientID)
		return
	}
	if myID == "" {
		m.log.Debug("data while unpaired dropped")
		return
	}
	if deviceID != "" && deviceID != myID {
		m.log.Debug("data for another device dropped", "client_id", clientID)
		return
	}
	var p payload
	if err := json.Unmarshal(raw, &p); err != nil {
		m.log.Debug("malformed payload dropped", "client_id", clientID, "err", err)
		return
	}
	switch {
	case p.HS != "":
		m.handleHandshake(s, &p)
	case p.Ciphertext != "":
		m.handleEnvelope(s, &p)
	default:
		m.log.Debug("payload without hs or ciphertext dropped", "client_id", clientID)
	}
}

// ─── handshake (SPEC §5) ─────────────────────────────────────────────────────

func (m *Manager) handleHandshake(s *session, p *payload) {
	switch p.HS {
	case "hello":
		m.handleHello(s, p)
	case "confirm":
		m.handleConfirm(s, p)
	default:
		m.log.Debug("unknown handshake message dropped", "hs", p.HS)
	}
}

func (m *Manager) handleHello(s *session, p *payload) {
	if p.V != ProtocolVersion {
		m.sendPlain(s, rejectMsg{V: ProtocolVersion, HS: "reject", Code: RejectVersion})
		return
	}
	pid, err := crypto.B64Decode(p.PairingID)
	if err != nil || len(pid) != crypto.PairingIDLen {
		m.log.Debug("hello with bad pairing_id dropped")
		return
	}
	pubC, err := crypto.B64Decode(p.EphPub)
	if err != nil || len(pubC) != crypto.X25519KeyLen {
		m.log.Debug("hello with bad eph_pub dropped")
		return
	}
	pk, ok := m.cfg.Pairings.Lookup(pid)
	if !ok {
		m.log.Info("hello with unknown pairing", "client_id", s.clientID)
		m.sendPlain(s, rejectMsg{V: ProtocolVersion, HS: "reject", Code: RejectUnknownPairing})
		return
	}
	eph, err := crypto.NewEphemeral()
	if err != nil {
		m.log.Error("ephemeral key", "err", err)
		return
	}
	keys, err := crypto.DeriveSessionKeysDevice(pk, pid, pubC, eph)
	if err != nil {
		m.log.Debug("hello key derivation failed", "err", err)
		return
	}
	pubD := eph.PublicKey().Bytes()
	// A new hello replaces any previous state (SPEC §5.3).
	s.mu.Lock()
	s.state = stAwaitConfirm
	s.keys = keys
	s.sendKey, s.recvKey = nil, nil
	s.sendCtr, s.recvCtr = 0, 0
	s.mu.Unlock()
	m.sendPlain(s, helloAckMsg{V: ProtocolVersion, HS: "hello_ack", EphPub: crypto.B64(pubD), MAC: crypto.B64(keys.MACD)})
}

func (m *Manager) handleConfirm(s *session, p *payload) {
	mac, err := crypto.B64Decode(p.MAC)
	s.mu.Lock()
	if s.state != stAwaitConfirm || s.keys == nil {
		s.mu.Unlock()
		m.log.Debug("confirm out of order dropped", "client_id", s.clientID)
		return
	}
	if err != nil || p.V != ProtocolVersion || !crypto.VerifyMAC(mac, s.keys.MACC) {
		s.state = stInit
		s.keys = nil
		s.mu.Unlock()
		m.log.Warn("handshake confirm failed", "client_id", s.clientID)
		return
	}
	sendKey, err1 := crypto.NewEnvelopeKey(s.keys.D2C)
	recvKey, err2 := crypto.NewEnvelopeKey(s.keys.C2D)
	if err1 != nil || err2 != nil {
		s.state = stInit
		s.mu.Unlock()
		return
	}
	s.sendKey, s.recvKey = sendKey, recvKey
	s.sendCtr, s.recvCtr = 0, 0
	s.state = stEstablished
	s.mu.Unlock()
	m.log.Info("handshake ok", "client_id", s.clientID)
	// First envelope: device_info (SPEC §5.3).
	m.send(s, m.deviceInfo())
	if m.cfg.OnHandshake != nil {
		m.cfg.OnHandshake(s.clientID)
	}
}

// sendPlain sends a cleartext handshake message.
func (m *Manager) sendPlain(s *session, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	if err := m.cfg.Transport.SendData(s.clientID, data); err != nil {
		m.log.Debug("send failed", "client_id", s.clientID, "err", err)
	}
}

// ─── envelopes (SPEC §6) ─────────────────────────────────────────────────────

func (m *Manager) handleEnvelope(s *session, p *payload) {
	m.mu.Lock()
	myID, myRaw := m.deviceID, m.deviceIDRaw
	m.mu.Unlock()
	if p.V != ProtocolVersion || p.DeviceID != myID {
		m.log.Debug("envelope with bad v/device_id dropped", "client_id", s.clientID)
		return
	}
	nonce, err := crypto.B64Decode(p.Nonce)
	if err != nil || len(nonce) != crypto.NonceLen || nonce[0] != crypto.DirC2D || nonce[1] != 0 || nonce[2] != 0 || nonce[3] != 0 {
		m.log.Debug("envelope with bad nonce dropped", "client_id", s.clientID)
		return
	}
	ct, err := crypto.B64Decode(p.Ciphertext)
	if err != nil {
		m.log.Debug("envelope with bad ciphertext dropped", "client_id", s.clientID)
		return
	}
	counter := binary.BigEndian.Uint64(nonce[4:])

	s.mu.Lock()
	if s.state != stEstablished || s.recvKey == nil {
		s.mu.Unlock()
		m.log.Debug("envelope before handshake dropped", "client_id", s.clientID)
		return
	}
	if counter != s.recvCtr {
		expected := s.recvCtr
		s.mu.Unlock()
		m.log.Warn("envelope counter mismatch (replay or loss)", "client_id", s.clientID, "got", counter, "expected", expected)
		m.closeSession(s, "counter")
		return
	}
	plaintext, err := s.recvKey.Open(crypto.DirC2D, counter, myRaw, ct)
	if err != nil {
		s.mu.Unlock()
		// Rule 7: never answer an envelope that does not authenticate.
		m.log.Debug("undecryptable envelope dropped", "client_id", s.clientID)
		return
	}
	s.recvCtr++
	if s.recvCtr > crypto.MaxCounter {
		s.mu.Unlock()
		m.closeSession(s, "counter exhausted")
		return
	}
	s.mu.Unlock()
	m.dispatch(s, plaintext)
}

// send seals and sends one application message on an established session.
func (m *Manager) send(s *session, v any) {
	plaintext, err := json.Marshal(v)
	if err != nil {
		m.log.Error("marshal", "err", err)
		return
	}
	m.mu.Lock()
	myID, myRaw := m.deviceID, m.deviceIDRaw
	m.mu.Unlock()
	s.mu.Lock()
	if s.closed || s.state != stEstablished || s.sendKey == nil {
		s.mu.Unlock()
		return
	}
	ctr := s.sendCtr
	if ctr > crypto.MaxCounter {
		s.mu.Unlock()
		m.closeSession(s, "counter exhausted")
		return
	}
	ct, err := s.sendKey.Seal(crypto.DirD2C, ctr, myRaw, plaintext)
	if err != nil {
		s.mu.Unlock()
		m.log.Error("seal", "err", err)
		return
	}
	s.sendCtr++
	env := envelopeMsg{V: ProtocolVersion, DeviceID: myID, Nonce: crypto.B64(crypto.EnvelopeNonce(crypto.DirD2C, ctr)), Ciphertext: crypto.B64(ct)}
	data, _ := json.Marshal(env)
	err = m.cfg.Transport.SendData(s.clientID, data)
	s.mu.Unlock()
	if err != nil {
		m.log.Debug("send failed", "client_id", s.clientID, "err", err)
	}
}

func (m *Manager) sendError(s *session, id, code, message string) {
	m.send(s, errorMsg{Type: "error", ID: id, Code: code, Message: message})
}

func (m *Manager) sendRetry(s *session, id, code string, retry time.Duration) {
	ms := retry.Milliseconds()
	if ms < 1 {
		ms = 1
	}
	m.send(s, errorMsg{Type: "error", ID: id, Code: code, RetryAfterMS: &ms})
}

func (m *Manager) deviceInfo() deviceInfoMsg {
	st := m.cfg.OllamaStatus()
	var pull *pullInfo
	m.mu.Lock()
	if m.pull != nil {
		pull = &pullInfo{Name: m.pull.name}
	}
	m.mu.Unlock()
	return deviceInfoMsg{
		Pull:             pull,
		Type:             "device_info",
		ProtocolVersions: []int{ProtocolVersion},
		TrayVersion:      m.cfg.TrayVersion,
		Platform:         m.cfg.Platform,
		Ollama:           ollamaInfo(st),
		Limits: limitsInfo{MaxMessageBytes: MaxMessageBytes, ChatConcurrency: 1, PullConcurrency: 1,
			MaxImagesPerMessage: MaxImagesPerMessage, MaxImageBytes: MaxImageBytes},
		Capabilities: []string{"history", "think", "images", "history_clear", "incognito", "agents", "chain"},
	}
}

// BroadcastDeviceInfo re-sends device_info to every established session (Ollama status changed).
func (m *Manager) BroadcastDeviceInfo() {
	m.mu.Lock()
	list := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.mu.Unlock()
	info := m.deviceInfo()
	for _, s := range list {
		m.send(s, info)
	}
}

// ollamaErrorCode maps a package ollama error to SPEC §7.5.
func ollamaErrorCode(err error) (string, string) {
	var inv ollama.ErrInvalid
	var ae *ollama.APIError
	switch {
	case errors.Is(err, ollama.ErrBadModelName):
		return ErrBadModelName, ""
	case ollama.IsUnreachable(err):
		return ErrOllamaDown, ""
	case ollama.IsNotFound(err):
		return ErrModelNotFound, ""
	case errors.As(err, &inv):
		return ErrInvalid, inv.Error()
	case errors.As(err, &ae):
		return ErrOllamaError, ae.Message
	case errors.Is(err, ollama.ErrLineTooLong):
		return ErrOllamaError, "response line too long"
	default:
		return ErrInternal, ""
	}
}

func withTimeout() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), requestTimeout)
}
