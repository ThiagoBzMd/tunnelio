package pairing

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/crypto"
)

// DefaultTimeout is the maximum silence between pairing messages (SPEC §4.2 rule 2).
const DefaultTimeout = 60 * time.Second

// Transport is the subset of the relay client used here.
type Transport interface {
	SendPairStart() error
	SendPairMsg(payload json.RawMessage) error
	SendPairDone(ok bool, name string) error
}

// Store persists a verified pairing (pairing_id → PK). config.Pairings satisfies it.
type Store interface {
	Add(pairingID, pk []byte, label string) error
}

// Config of a Pairer.
type Config struct {
	Transport  Transport
	Store      Store
	DeviceName string // suggested name sent in pair_done
	Logger     *slog.Logger
	Timeout    time.Duration

	// OnCode receives the formatted code (CCCC-SSSS-SSSS) to show to the user.
	OnCode func(code string)
	// OnResult is called once per pairing attempt: ok=true after pair_done{ok:true}.
	OnResult func(ok bool, err error)
	// OnPaired is called on the first pairing when the relay issues device_id + token.
	OnPaired func(deviceID, deviceToken string)
}

type state int

const (
	stIdle state = iota
	stWaitReady
	stWaitJoin
	stWaitPake1
	stWaitPake3
)

// Pairer runs the device side (B) of one pairing at a time.
type Pairer struct {
	cfg Config
	log *slog.Logger

	mu      sync.Mutex
	st      state
	secret  string
	code    string // normalized 12 symbols
	spake   *crypto.SPAKE2
	result  *crypto.SPAKE2Result
	timer   *time.Timer
	expires time.Time
	gen     int // attempt counter, guards stale timers
}

// SPAKE2 payloads inside pair_msg (SPEC §4.4).
type pake1 struct {
	T  string `json:"t"`
	V  int    `json:"v"`
	PA string `json:"pA"`
}

type pake2 struct {
	T  string `json:"t"`
	V  int    `json:"v"`
	PB string `json:"pB"`
	CB string `json:"cB"`
}

type pake3 struct {
	T  string `json:"t"`
	V  int    `json:"v"`
	CA string `json:"cA"`
}

var (
	// ErrBusy is returned by Start while a pairing is in progress.
	ErrBusy = errors.New("pairing: already in progress")
	// ErrTimeout is reported when 60 s pass without a message once a browser has joined.
	ErrTimeout = errors.New("pairing: timeout")
	// ErrCodeExpired is reported when no browser joins before the code expires (server TTL, 5 min).
	ErrCodeExpired = errors.New("pairing: code expired")
	// ErrAborted is reported on pair_aborted or relay disconnect.
	ErrAborted = errors.New("pairing: aborted")
	// ErrBadMAC is reported when cA does not verify (wrong code or active attack).
	ErrBadMAC    = errors.New("pairing: confirmation MAC mismatch")
	errMalformed = errors.New("pairing: malformed message")
)

// New creates a Pairer.
func New(cfg Config) *Pairer {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = DefaultTimeout
	}
	return &Pairer{cfg: cfg, log: cfg.Logger}
}

// Active reports whether a pairing is in progress.
func (p *Pairer) Active() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.st != stIdle
}

// Start generates the secret and sends pair_start. The code is delivered via OnCode once the
// relay answers pair_ready.
func (p *Pairer) Start() error {
	p.mu.Lock()
	if p.st != stIdle {
		p.mu.Unlock()
		return ErrBusy
	}
	secret, err := crypto.GenerateSecret()
	if err != nil {
		p.mu.Unlock()
		return err
	}
	p.secret = secret
	p.st = stWaitReady
	p.gen++
	p.armTimerLocked()
	p.mu.Unlock()
	if err := p.cfg.Transport.SendPairStart(); err != nil {
		p.fail(err)
		return err
	}
	return nil
}

// Cancel aborts the current pairing (user action). No-op when idle.
func (p *Pairer) Cancel() { p.fail(ErrAborted) }

// HandlePairReady composes claim||secret and shows the code.
// DefaultCodeTTL is used when pair_ready carries no parseable expires_at (SPEC §3.8: 5 min).
const DefaultCodeTTL = 5 * time.Minute

func (p *Pairer) HandlePairReady(claim, expiresAt string) {
	p.mu.Lock()
	if p.st != stWaitReady {
		p.mu.Unlock()
		return
	}
	code := crypto.NormalizeCode(claim + p.secret)
	if err := crypto.ValidateCode(code); err != nil || len(claim) != crypto.ClaimLen {
		p.mu.Unlock()
		p.fail(fmt.Errorf("pairing: bad claim %q", claim))
		return
	}
	w, err := crypto.CodeToW(code)
	if err != nil {
		p.mu.Unlock()
		p.fail(err)
		return
	}
	sp, err := crypto.NewSPAKE2(crypto.SPAKE2RoleB, []byte(crypto.SPAKE2IdentityA), []byte(crypto.SPAKE2IdentityB), []byte(crypto.SPAKE2AAD), w)
	if err != nil {
		p.mu.Unlock()
		p.fail(err)
		return
	}
	p.code = code
	p.spake = sp
	p.st = stWaitJoin
	ttl := DefaultCodeTTL
	if t, err := time.Parse(time.RFC3339, expiresAt); err == nil {
		if d := time.Until(t); d > 0 {
			ttl = d
		}
	}
	p.expires = time.Now().Add(ttl)
	p.armTimerLockedFor(ttl, ErrCodeExpired)
	onCode := p.cfg.OnCode
	p.mu.Unlock()
	p.log.Info("pairing code ready (shown to the user, never logged)")
	if onCode != nil {
		onCode(crypto.FormatCode(code))
	}
}

// HandlePairJoined accepts exactly one browser.
func (p *Pairer) HandlePairJoined() {
	p.mu.Lock()
	if p.st != stWaitJoin {
		st := p.st
		p.mu.Unlock()
		if st != stIdle {
			p.fail(errors.New("pairing: unexpected second pair_joined"))
		}
		return
	}
	p.st = stWaitPake1
	p.armTimerLocked()
	p.mu.Unlock()
}

// HandlePairMsg processes pake1 and pake3.
func (p *Pairer) HandlePairMsg(payload json.RawMessage) {
	var head struct {
		T string `json:"t"`
		V int    `json:"v"`
	}
	if err := json.Unmarshal(payload, &head); err != nil || head.V != 1 {
		p.fail(errMalformed)
		return
	}
	switch head.T {
	case "pake1":
		p.handlePake1(payload)
	case "pake3":
		p.handlePake3(payload)
	default:
		p.fail(errMalformed)
	}
}

func (p *Pairer) handlePake1(payload json.RawMessage) {
	p.mu.Lock()
	if p.st != stWaitPake1 {
		p.mu.Unlock()
		p.fail(errors.New("pairing: pake1 out of order"))
		return
	}
	var m pake1
	if err := json.Unmarshal(payload, &m); err != nil {
		p.mu.Unlock()
		p.fail(errMalformed)
		return
	}
	pA, err := crypto.B64Decode(m.PA)
	if err != nil {
		p.mu.Unlock()
		p.fail(errMalformed)
		return
	}
	pB := p.spake.Message()
	res, err := p.spake.Finish(pA)
	if err != nil {
		p.mu.Unlock()
		p.fail(err)
		return
	}
	p.result = res
	p.st = stWaitPake3
	p.armTimerLocked()
	p.mu.Unlock()
	out, _ := json.Marshal(pake2{T: "pake2", V: 1, PB: crypto.B64(pB), CB: crypto.B64(res.CB)})
	if err := p.cfg.Transport.SendPairMsg(out); err != nil {
		p.fail(err)
	}
}

func (p *Pairer) handlePake3(payload json.RawMessage) {
	p.mu.Lock()
	if p.st != stWaitPake3 {
		p.mu.Unlock()
		p.fail(errors.New("pairing: pake3 out of order"))
		return
	}
	var m pake3
	if err := json.Unmarshal(payload, &m); err != nil {
		p.mu.Unlock()
		p.fail(errMalformed)
		return
	}
	cA, err := crypto.B64Decode(m.CA)
	if err != nil || len(cA) != 32 {
		p.mu.Unlock()
		p.fail(errMalformed)
		return
	}
	if !p.result.VerifyCA(cA) {
		p.mu.Unlock()
		p.fail(ErrBadMAC)
		return
	}
	pk := crypto.PairingKey(p.result.Ke)
	pid := crypto.PairingID(pk)
	// Persist BEFORE pair_done (SPEC §4.2 rule 3).
	label := "Browser paired " + time.Now().UTC().Format("2006-01-02 15:04")
	if err := p.cfg.Store.Add(pid, pk, label); err != nil {
		p.mu.Unlock()
		p.fail(fmt.Errorf("pairing: persist: %w", err))
		return
	}
	p.resetLocked()
	onResult := p.cfg.OnResult
	p.mu.Unlock()
	p.log.Info("pairing verified and stored", "pairing_id", crypto.B64(pid))
	err = p.cfg.Transport.SendPairDone(true, p.cfg.DeviceName)
	if err != nil {
		p.log.Warn("pair_done send failed", "err", err)
	}
	if onResult != nil {
		onResult(err == nil, err)
	}
}

// HandlePairAborted is called on pair_aborted from the relay.
func (p *Pairer) HandlePairAborted(reason string) {
	p.failNoReport(fmt.Errorf("%w: %s", ErrAborted, reason))
}

// HandleDisconnected is called when the relay connection drops.
func (p *Pairer) HandleDisconnected() { p.failNoReport(ErrAborted) }

// HandlePaired is called on paired{device_id, device_token} (first pairing only).
func (p *Pairer) HandlePaired(deviceID, deviceToken string) {
	if p.cfg.OnPaired != nil {
		p.cfg.OnPaired(deviceID, deviceToken)
	}
}

// fail aborts the attempt: pair_done{ok:false} (if a session exists), secret discarded.
func (p *Pairer) fail(err error) { p.failWith(err, true) }

// failNoReport aborts without sending pair_done (the relay already ended the session).
func (p *Pairer) failNoReport(err error) { p.failWith(err, false) }

func (p *Pairer) failWith(err error, report bool) {
	p.mu.Lock()
	if p.st == stIdle {
		p.mu.Unlock()
		return
	}
	sendDone := report && p.st != stWaitReady
	p.resetLocked()
	onResult := p.cfg.OnResult
	p.mu.Unlock()
	p.log.Warn("pairing failed", "err", err)
	if sendDone {
		if e := p.cfg.Transport.SendPairDone(false, ""); e != nil {
			p.log.Debug("pair_done{ok:false} not sent", "err", e)
		}
	}
	if onResult != nil {
		onResult(false, err)
	}
}

func (p *Pairer) resetLocked() {
	p.st = stIdle
	p.secret = ""
	p.code = ""
	p.spake = nil
	p.result = nil
	p.gen++
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
}

func (p *Pairer) armTimerLocked() { p.armTimerLockedFor(p.cfg.Timeout, ErrTimeout) }

func (p *Pairer) armTimerLockedFor(d time.Duration, cause error) {
	if p.timer != nil {
		p.timer.Stop()
	}
	gen := p.gen
	p.timer = time.AfterFunc(d, func() {
		p.mu.Lock()
		stale := p.gen != gen || p.st == stIdle
		p.mu.Unlock()
		if !stale {
			p.fail(cause)
		}
	})
}

// Expires returns when the current code stops being accepted (zero when idle).
func (p *Pairer) Expires() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.expires
}
