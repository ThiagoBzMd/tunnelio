package channel

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/ollama"
)

// activePull is the single in-flight pull of this device (SPEC §7.6). Since rev. 1.9 it belongs to no
// browser: it goes on when the session that asked for it closes (the computer finishes the
// download and says so in its own notifications), and every session that asks for the same model
// while it runs joins it and gets its progress. Fields other than name and cancel are guarded by
// Manager.mu.
type activePull struct {
	name      string
	cancel    context.CancelFunc
	listeners []pullListener
	last      *pullProgressMsg // the latest progress, for a session that joins
}

// pullListener is one request waiting for the pull: its session and its request id.
type pullListener struct {
	session *session
	id      string
}

func (m *Manager) handlePull(s *session, id string, raw []byte) {
	var req pullModelReq
	if err := decode(raw, &req); err != nil {
		m.sendError(s, id, ErrInvalid, "")
		return
	}
	if err := ollama.ValidatePullName(req.Name); err != nil {
		m.sendError(s, id, ErrBadModelName, "")
		return
	}
	m.mu.Lock()
	if run := m.pull; run != nil {
		if run.name != req.Name {
			m.mu.Unlock()
			m.sendError(s, id, ErrPullBusy, "")
			return
		}
		// The same model is already downloading: join it.
		run.listeners = append(run.listeners, pullListener{session: s, id: id})
		var last *pullProgressMsg
		if run.last != nil {
			msg := *run.last
			msg.ID = id
			last = &msg
		}
		m.mu.Unlock()
		if last != nil {
			m.send(s, *last)
		}
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	run := &activePull{name: req.Name, cancel: cancel, listeners: []pullListener{{session: s, id: id}}}
	m.pull = run
	m.mu.Unlock()
	// Tray rule 3: a pull is always announced locally.
	m.cfg.Notifier.Notify("Tunnelio", fmt.Sprintf("Downloading %s…", req.Name))
	go m.runPull(ctx, run)
}

// toListeners sends one message to every request waiting for the pull (closed sessions drop it).
func (m *Manager) toListeners(run *activePull, msg func(id string) any) {
	m.mu.Lock()
	list := append([]pullListener(nil), run.listeners...)
	m.mu.Unlock()
	for _, l := range list {
		m.send(l.session, msg(l.id))
	}
}

// has is true when id is a request of session s waiting for the pull.
func (run *activePull) has(s *session, id string) bool {
	for _, l := range run.listeners {
		if l.session == s && l.id == id {
			return true
		}
	}
	return false
}

// dropSession takes the requests of a closed session off the pull (which goes on).
func (run *activePull) dropSession(s *session) {
	kept := run.listeners[:0]
	for _, l := range run.listeners {
		if l.session != s {
			kept = append(kept, l)
		}
	}
	run.listeners = kept
}

func (m *Manager) runPull(ctx context.Context, run *activePull) {
	name := run.name
	defer func() {
		run.cancel()
		m.mu.Lock()
		if m.pull == run {
			m.pull = nil
		}
		m.mu.Unlock()
	}()

	var mu sync.Mutex
	var pending *pullProgressMsg
	var timer *time.Timer
	last := time.Now().Add(-m.cfg.PullInterval)
	var total int64
	flush := func() {
		if pending == nil {
			return
		}
		msg := *pending
		m.mu.Lock()
		run.last = &msg
		m.mu.Unlock()
		m.toListeners(run, func(id string) any {
			out := msg
			out.ID = id
			return out
		})
		pending = nil
		last = time.Now()
	}
	err := m.cfg.Ollama.Pull(ctx, name, func(p ollama.PullProgress) {
		mu.Lock()
		defer mu.Unlock()
		if p.Total > total {
			total = p.Total
		}
		msg := &pullProgressMsg{Type: "pull_progress", Name: name, Status: p.Status}
		if p.Total > 0 {
			t, c := p.Total, p.Completed
			msg.Total, msg.Completed = &t, &c
		}
		pending = msg
		if since := time.Since(last); since >= m.cfg.PullInterval {
			if timer != nil {
				timer.Stop()
				timer = nil
			}
			flush()
		} else if timer == nil {
			timer = time.AfterFunc(m.cfg.PullInterval-since, func() {
				mu.Lock()
				defer mu.Unlock()
				timer = nil
				flush()
			})
		}
	})
	mu.Lock()
	if timer != nil {
		timer.Stop()
		timer = nil
	}
	flush()
	mu.Unlock()
	if err != nil {
		code, msg := ollamaErrorCode(err)
		if ctx.Err() != nil {
			code, msg = ErrInternal, "pull canceled"
		}
		m.log.Warn("pull failed", "name", name, "err", err)
		m.toListeners(run, func(id string) any { return errorMsg{Type: "error", ID: id, Code: code, Message: msg} })
		m.cfg.Notifier.Notify("Tunnelio", fmt.Sprintf("Download of %s failed", name))
		return
	}
	m.toListeners(run, func(id string) any { return pullDoneMsg{Type: "pull_done", ID: id, Name: name} })
	size := ""
	if total > 0 {
		size = " (" + humanBytes(total) + ")"
	}
	m.cfg.Notifier.Notify("Tunnelio", fmt.Sprintf("Downloaded %s%s", name, size))
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}
