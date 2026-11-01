package channel

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/history"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/ollama"
)

// historyClearTimeout bounds DELETE + VACUUM of a large history file.
const historyClearTimeout = 5 * time.Minute

// dispatch is THE allowlist (SPEC §7.2, tray rule 1): one switch, no dynamic fallback.
// Unknown types are dropped and logged; no reply.
func (m *Manager) dispatch(s *session, plaintext []byte) {
	var head requestHead
	if err := json.Unmarshal(plaintext, &head); err != nil {
		m.log.Warn("message is not a JSON object; dropped", "client_id", s.clientID)
		return
	}
	switch head.Type {
	case "list_models", "list_running", "show_model", "chat", "abort",
		"pull_model", "delete_model", "history_list", "history_get", "history_delete", "history_clear",
		"agent_list", "agent_save", "agent_delete", "skill_list", "skill_save", "skill_delete":
	default:
		m.log.Warn("unknown message type dropped", "client_id", s.clientID, "type", head.Type)
		return
	}
	if len(plaintext) > MaxMessageBytes {
		m.sendError(s, head.ID, ErrTooLarge, "")
		return
	}
	if head.ID == "" || len(head.ID) > maxRequestID {
		m.sendError(s, head.ID, ErrInvalid, "invalid id")
		return
	}
	if ok, wait := s.bucket.take(); !ok {
		m.sendRetry(s, head.ID, ErrRateLimit, wait)
		return
	}
	// Handlers run off the relay read loop; message order is already fixed by the counter.
	switch head.Type {
	case "list_models":
		go m.handleListModels(s, head.ID)
	case "list_running":
		go m.handleListRunning(s, head.ID)
	case "show_model":
		go m.handleShowModel(s, head.ID, plaintext)
	case "chat":
		m.handleChat(s, head.ID, plaintext)
	case "abort":
		m.handleAbort(s, head.ID, plaintext)
	case "pull_model":
		m.handlePull(s, head.ID, plaintext)
	case "delete_model":
		go m.handleDeleteModel(s, head.ID, plaintext)
	case "history_list":
		go m.handleHistoryList(s, head.ID, plaintext)
	case "history_get":
		go m.handleHistoryGet(s, head.ID, plaintext)
	case "history_delete":
		go m.handleHistoryDelete(s, head.ID, plaintext)
	case "history_clear":
		go m.handleHistoryClear(s, head.ID)
	case "agent_list":
		go m.handleAgentList(s, head.ID)
	case "agent_save":
		go m.handleAgentSave(s, head.ID, plaintext)
	case "agent_delete":
		go m.handleAgentDelete(s, head.ID, plaintext)
	case "skill_list":
		go m.handleSkillList(s, head.ID)
	case "skill_save":
		go m.handleSkillSave(s, head.ID, plaintext)
	case "skill_delete":
		go m.handleSkillDelete(s, head.ID, plaintext)
	}
}

func decode(raw []byte, v any) error {
	return json.Unmarshal(raw, v)
}

func toDetails(d ollama.ModelDetails) modelDetails {
	return modelDetails{Family: d.Family, Families: d.Families, ParameterSize: d.ParameterSize,
		QuantizationLevel: d.QuantizationLevel, Format: d.Format}
}

func (m *Manager) handleListModels(s *session, id string) {
	ctx, cancel := withTimeout()
	defer cancel()
	models, err := m.cfg.Ollama.ListModels(ctx)
	if err != nil {
		code, msg := ollamaErrorCode(err)
		m.sendError(s, id, code, msg)
		return
	}
	out := modelsMsg{Type: "models", ID: id, Models: make([]modelEntry, 0, len(models))}
	for _, mo := range models {
		out.Models = append(out.Models, modelEntry{Name: mo.Name, Size: mo.Size, ModifiedAt: mo.ModifiedAt, Digest: mo.Digest, Details: toDetails(mo.Details)})
	}
	m.send(s, out)
}

func (m *Manager) handleListRunning(s *session, id string) {
	ctx, cancel := withTimeout()
	defer cancel()
	running, err := m.cfg.Ollama.ListRunning(ctx)
	if err != nil {
		code, msg := ollamaErrorCode(err)
		m.sendError(s, id, code, msg)
		return
	}
	out := runningMsg{Type: "running", ID: id, Models: make([]runningEntry, 0, len(running))}
	for _, r := range running {
		e := runningEntry{Name: r.Name, Size: r.Size, SizeVRAM: r.SizeVRAM, ExpiresAt: r.ExpiresAt}
		if r.ContextLength > 0 {
			n := r.ContextLength
			e.ContextLength = &n
		}
		if r.Details != nil {
			d := toDetails(*r.Details)
			e.Details = &d
		}
		out.Models = append(out.Models, e)
	}
	m.send(s, out)
}

func (m *Manager) handleShowModel(s *session, id string, raw []byte) {
	var req showModelReq
	if err := decode(raw, &req); err != nil {
		m.sendError(s, id, ErrInvalid, "")
		return
	}
	if err := ollama.ValidateModelName(req.Name); err != nil {
		m.sendError(s, id, ErrBadModelName, "")
		return
	}
	ctx, cancel := withTimeout()
	defer cancel()
	info, err := m.cfg.Ollama.ShowModel(ctx, req.Name)
	if err != nil {
		code, msg := ollamaErrorCode(err)
		m.sendError(s, id, code, msg)
		return
	}
	m.send(s, modelInfoMsg{Type: "model_info", ID: id, Name: info.Name, Details: toDetails(info.Details),
		Capabilities: info.Capabilities, ContextLength: info.ContextLength,
		Parameters: info.Parameters, Template: info.Template, License: info.License})
}

func (m *Manager) handleDeleteModel(s *session, id string, raw []byte) {
	var req deleteModelReq
	if err := decode(raw, &req); err != nil {
		m.sendError(s, id, ErrInvalid, "")
		return
	}
	if err := ollama.ValidateModelName(req.Name); err != nil {
		m.sendError(s, id, ErrBadModelName, "")
		return
	}
	ctx, cancel := withTimeout()
	defer cancel()
	if err := m.cfg.Ollama.Delete(ctx, req.Name); err != nil {
		code, msg := ollamaErrorCode(err)
		m.sendError(s, id, code, msg)
		return
	}
	m.send(s, okMsg{Type: "ok", ID: id})
}

func (m *Manager) handleHistoryList(s *session, id string, raw []byte) {
	var req historyListReq
	if err := decode(raw, &req); err != nil {
		m.sendError(s, id, ErrInvalid, "")
		return
	}
	limit := history.DefaultListLimit
	if req.Limit != nil {
		if *req.Limit < 1 || *req.Limit > history.MaxListLimit {
			m.sendError(s, id, ErrInvalid, "limit out of range")
			return
		}
		limit = *req.Limit
	}
	ctx, cancel := withTimeout()
	defer cancel()
	list, more, err := m.cfg.History.List(ctx, limit, req.Before)
	if err != nil {
		m.log.Warn("history_list", "err", err)
		m.sendError(s, id, ErrInvalid, "bad cursor")
		return
	}
	total, size, err := m.cfg.History.Stats(ctx)
	if err != nil {
		m.log.Warn("history stats", "err", err)
	}
	m.send(s, historyMsg{Type: "history", ID: id, Conversations: list, HasMore: more, TotalConversations: total, TotalBytes: size})
}

func (m *Manager) handleHistoryGet(s *session, id string, raw []byte) {
	var req historyGetReq
	if err := decode(raw, &req); err != nil || !history.IsValidUUID(req.ConversationID) {
		m.sendError(s, id, ErrInvalid, "")
		return
	}
	var after int64
	if req.AfterSeq != nil {
		if *req.AfterSeq < 0 {
			m.sendError(s, id, ErrInvalid, "after_seq must be >= 0")
			return
		}
		after = *req.AfterSeq
	}
	limit := history.DefaultGetLimit
	if req.Limit != nil {
		if *req.Limit < 1 || *req.Limit > history.MaxGetLimit {
			m.sendError(s, id, ErrInvalid, "limit out of range")
			return
		}
		limit = *req.Limit
	}
	ctx, cancel := withTimeout()
	defer cancel()
	conv, msgs, more, err := m.cfg.History.Get(ctx, req.ConversationID, after, limit)
	if errors.Is(err, history.ErrNotFound) {
		m.sendError(s, id, ErrNotFound, "")
		return
	}
	if err != nil {
		m.log.Warn("history_get", "err", err)
		m.sendError(s, id, ErrInternal, "")
		return
	}
	m.send(s, conversationMsg{Type: "conversation", ID: id,
		Conversation: conversationHead{ID: conv.ID, Title: conv.Title, Model: conv.Model, CreatedAt: conv.CreatedAt, UpdatedAt: conv.UpdatedAt,
			AgentID: conv.AgentID, SkillIDs: conv.SkillIDs},
		Messages: msgs, HasMore: more})
}

func (m *Manager) handleHistoryDelete(s *session, id string, raw []byte) {
	var req historyDeleteReq
	if err := decode(raw, &req); err != nil || !history.IsValidUUID(req.ConversationID) {
		m.sendError(s, id, ErrInvalid, "")
		return
	}
	ctx, cancel := withTimeout()
	defer cancel()
	err := m.cfg.History.Delete(ctx, req.ConversationID)
	if errors.Is(err, history.ErrNotFound) {
		m.sendError(s, id, ErrNotFound, "")
		return
	}
	if err != nil {
		m.log.Warn("history_delete", "err", err)
		m.sendError(s, id, ErrInternal, "")
		return
	}
	m.send(s, okMsg{Type: "ok", ID: id})
}

// handleHistoryClear deletes every conversation on this computer and returns the space to the
// disk (rev. 1.4, Settings → Conversations → Delete all).
func (m *Manager) handleHistoryClear(s *session, id string) {
	ctx, cancel := context.WithTimeout(context.Background(), historyClearTimeout)
	defer cancel()
	if err := m.cfg.History.Clear(ctx); err != nil {
		m.log.Warn("history_clear", "err", err)
		m.sendError(s, id, ErrInternal, "")
		return
	}
	m.log.Info("all conversations deleted", "client_id", s.clientID)
	m.send(s, okMsg{Type: "ok", ID: id})
}
