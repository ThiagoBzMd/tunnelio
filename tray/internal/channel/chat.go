package channel

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/history"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/ollama"
)

const (
	maxChatMessages = 500
	maxTitleBytes   = 200
	busyRetry       = time.Second
)

// activeChat is the single in-flight chat of this device (SPEC §7.6).
type activeChat struct {
	id      string
	session *session
	cancel  context.CancelFunc
}

// coalescer batches streamed text so that frames are spaced ≥ interval apart.
type coalescer struct {
	mu       sync.Mutex
	interval time.Duration
	last     time.Time
	timer    *time.Timer
	content  strings.Builder
	thinking strings.Builder
	flush    func(content, thinking string)
	stopped  bool
}

func newCoalescer(interval time.Duration, flush func(content, thinking string)) *coalescer {
	return &coalescer{interval: interval, flush: flush, last: time.Now().Add(-interval)}
}

func (c *coalescer) add(content, thinking string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped {
		return
	}
	c.content.WriteString(content)
	c.thinking.WriteString(thinking)
	if since := time.Since(c.last); since >= c.interval {
		c.flushLocked()
		return
	} else if c.timer == nil {
		c.timer = time.AfterFunc(c.interval-since, func() {
			c.mu.Lock()
			defer c.mu.Unlock()
			c.timer = nil
			if !c.stopped {
				c.flushLocked()
			}
		})
	}
}

func (c *coalescer) flushLocked() {
	if c.content.Len() == 0 && c.thinking.Len() == 0 {
		return
	}
	content, thinking := c.content.String(), c.thinking.String()
	c.content.Reset()
	c.thinking.Reset()
	c.last = time.Now()
	c.flush(content, thinking)
}

// stop flushes what is pending and disables further flushes.
func (c *coalescer) stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
	c.flushLocked()
	c.stopped = true
}

func validateChat(req *chatReq, rawLen int) (string, string) {
	if !history.IsValidUUID(req.ConversationID) {
		return ErrInvalid, "conversation_id must be a UUID"
	}
	switch req.Mode { // "cloud" existed until rev. 1.3 (conversations are only on this computer now)
	case "private", "incognito":
	default:
		return ErrInvalid, "mode must be private or incognito"
	}
	if err := ollama.ValidateModelName(req.Model); err != nil {
		return ErrBadModelName, ""
	}
	if len(req.Messages) < 1 || len(req.Messages) > maxChatMessages {
		return ErrInvalid, "messages must have 1-500 items"
	}
	for _, msg := range req.Messages {
		switch msg.Role {
		case "system", "user", "assistant":
		default:
			return ErrInvalid, "invalid role"
		}
	}
	if rawLen > MaxMessageBytes {
		return ErrTooLarge, ""
	}
	if len(req.Title) > maxTitleBytes {
		return ErrInvalid, "title too long"
	}
	switch req.KeepAlive {
	case "", "0", "5m", "30m", "1h":
	default:
		return ErrInvalid, "invalid keep_alive"
	}
	if msg := validateSetup(req.AgentID, req.SkillIDs); msg != "" {
		return ErrInvalid, msg
	}
	if _, msg := validateChainSteps(req.Chain); msg != "" {
		return ErrInvalid, msg
	}
	return "", ""
}

func (m *Manager) handleChat(s *session, id string, raw []byte) {
	var req chatReq
	if err := decode(raw, &req); err != nil {
		m.sendError(s, id, ErrInvalid, "")
		return
	}
	if code, msg := validateChat(&req, len(raw)); code != "" {
		m.sendError(s, id, code, msg)
		return
	}
	images, reason := decodeChatImages(req.Messages)
	if reason != "" {
		m.sendError(s, id, ErrInvalid, reason)
		return
	}
	opts, err := ollama.ParseChatOptions(req.Options)
	if err != nil {
		m.sendError(s, id, ErrInvalid, err.Error())
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.mu.Lock()
	if m.chat != nil {
		m.mu.Unlock()
		cancel()
		m.sendRetry(s, id, ErrBusy, busyRetry)
		return
	}
	run := &activeChat{id: id, session: s, cancel: cancel}
	m.chat = run
	m.mu.Unlock()
	go m.runChat(ctx, run, &req, opts, images)
}

// runChat drives one chat. images is indexed like req.Messages (decoded, validated).
func (m *Manager) runChat(ctx context.Context, run *activeChat, req *chatReq, opts *ollama.ChatOptions, images [][]history.Image) {
	s, id := run.session, run.id
	defer func() {
		run.cancel()
		m.mu.Lock()
		if m.chat == run {
			m.chat = nil
		}
		m.mu.Unlock()
	}()

	// The conversation lives on this computer (SPEC §9; "cloud" left with rev. 1.3) — unless the
	// browser asked for an incognito chat, which touches no history at all (nothing is created,
	// nothing is appended, the reply carries no message_id).
	incognito := req.Mode == "incognito"
	last := lastUser(req.Messages)
	var user chatMessage
	var userImages []history.Image
	if last >= 0 {
		user, userImages = req.Messages[last], images[last]
	}
	if !incognito {
		title := req.Title
		if title == "" {
			title = history.TitleFromContent(user.Content)
		}
		hctx, hcancel := withTimeout()
		if _, err := m.cfg.History.EnsureConversation(hctx, req.ConversationID, title, req.Model); err != nil {
			hcancel()
			m.log.Error("history: ensure conversation", "err", err)
			m.sendError(s, id, ErrInternal, "")
			m.send(s, chatDoneMsg{Type: "chat_done", ID: id, ConversationID: req.ConversationID, DoneReason: "error"})
			return
		}
		if err := m.cfg.History.SetConversationSetup(hctx, req.ConversationID, req.AgentID, req.SkillIDs); err != nil {
			m.log.Error("history: conversation agent", "err", err)
		}
		if last >= 0 && (user.Content != "" || len(userImages) > 0) {
			if _, err := m.cfg.History.AppendMessage(hctx, req.ConversationID, history.NewMessage{Role: "user", Content: user.Content, Images: userImages}); err != nil {
				m.log.Error("history: append user message", "err", err)
			}
		}
		hcancel()
	}

	msgs := make([]ollama.Message, 0, len(req.Messages))
	for i, mm := range req.Messages {
		om := ollama.Message{Role: mm.Role, Content: mm.Content}
		for _, img := range images[i] {
			om.Images = append(om.Images, img.Data)
		}
		msgs = append(msgs, om)
	}
	var full, fullThinking strings.Builder
	co := newCoalescer(m.cfg.ChunkInterval, func(content, thinking string) {
		m.send(s, chatChunkMsg{Type: "chat_chunk", ID: id, Content: content, Thinking: thinking})
	})
	res, err := m.cfg.Ollama.Chat(ctx, ollama.ChatRequest{Model: req.Model, Messages: msgs, Options: opts, Think: req.Think, KeepAlive: req.KeepAlive},
		func(ch ollama.ChatChunk) {
			full.WriteString(ch.Content)
			fullThinking.WriteString(ch.Thinking)
			co.add(ch.Content, ch.Thinking)
		})
	co.stop()

	done := chatDoneMsg{Type: "chat_done", ID: id, ConversationID: req.ConversationID}
	var stats *history.Stats
	switch {
	case err == nil:
		done.DoneReason = "stop"
		if res.DoneReason == "length" {
			done.DoneReason = "length"
		}
		done.Stats = &statsMsg{TotalDuration: res.Stats.TotalDuration, LoadDuration: res.Stats.LoadDuration,
			PromptEvalCount: res.Stats.PromptEvalCount, PromptEvalDuration: res.Stats.PromptEvalDuration,
			EvalCount: res.Stats.EvalCount, EvalDuration: res.Stats.EvalDuration}
		stats = &history.Stats{TotalDuration: res.Stats.TotalDuration, LoadDuration: res.Stats.LoadDuration,
			PromptEvalCount: res.Stats.PromptEvalCount, PromptEvalDuration: res.Stats.PromptEvalDuration,
			EvalCount: res.Stats.EvalCount, EvalDuration: res.Stats.EvalDuration}
	case errors.Is(err, context.Canceled):
		done.DoneReason = "abort"
	default:
		done.DoneReason = "error"
		code, msg := ollamaErrorCode(err)
		m.log.Warn("chat failed", "client_id", s.clientID, "code", code, "err", err)
		m.sendError(s, id, code, msg)
	}

	if !incognito && (done.DoneReason != "error" || full.Len() > 0) {
		model := req.Model
		var thinking *string
		if fullThinking.Len() > 0 {
			t := fullThinking.String()
			thinking = &t
		}
		chain, _ := validateChainSteps(req.Chain) // validated in validateChat
		hctx, hcancel := withTimeout()
		saved, herr := m.cfg.History.AppendMessage(hctx, req.ConversationID, history.NewMessage{
			Role: "assistant", Content: full.String(), Thinking: thinking, Model: &model, Stats: stats,
			Aborted: done.DoneReason == "abort", Chain: chain,
		})
		hcancel()
		if herr != nil {
			m.log.Error("history: append assistant message", "err", herr)
		} else {
			done.MessageID = saved.ID
		}
	}
	m.send(s, done)
}

// lastUser returns the index of the last user message, or -1.
func lastUser(msgs []chatMessage) int {
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "user" {
			return i
		}
	}
	return -1
}

func (m *Manager) handleAbort(s *session, id string, raw []byte) {
	var req abortReq
	if err := decode(raw, &req); err != nil || req.TargetID == "" {
		m.sendError(s, id, ErrInvalid, "")
		return
	}
	m.mu.Lock()
	run := m.chat
	pull := m.pull
	isPull := pull != nil && pull.has(s, req.TargetID)
	m.mu.Unlock()
	if isPull { // rev. 1.9: a request waiting for the download cancels it (SPEC §7.6)
		pull.cancel()
		m.send(s, okMsg{Type: "ok", ID: id})
		return
	}
	if run == nil || run.id != req.TargetID || run.session != s {
		m.sendError(s, id, ErrNotFound, "no such chat")
		return
	}
	run.cancel()
	m.send(s, okMsg{Type: "ok", ID: id})
}
