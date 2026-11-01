package channel

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/history"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/ollama"
)

// Agents and skills (SPEC §7.3, §9.4): agent_list / agent_save / agent_delete and skill_list /
// skill_save / skill_delete read and write this computer's history file. None of them reaches
// Ollama or the system; the browser composes the system message from what they hold.

const (
	nameMaxRunes             = 80
	agentDescriptionMaxRunes = 300
	skillDescriptionMaxRunes = 500
	instructionsMaxBytes     = 32 << 10
	maxSkillIDs              = history.MaxSkills
	// maxChain is how many agents may answer after the chosen one (SPEC §9.4).
	maxChain = 5
	// chainStepMaxBytes bounds the answer of one earlier agent kept with the final message.
	chainStepMaxBytes = 512 << 10
)

var (
	iconPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	// skillCategories are the skill editor's categories; "" = none.
	skillCategories = map[string]bool{"": true, "ideas": true, "travel": true, "learning": true, "writing": true,
		"shopping": true, "code": true, "misc": true, "roleplay": true, "finance": true}
	skillsModes = map[string]bool{"off": true, "all": true, "selected": true}
)

type agentInput struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	Icon         string          `json:"icon"`
	Model        string          `json:"model"`
	Instructions string          `json:"instructions"`
	Options      json.RawMessage `json:"options,omitempty"`
	Think        *bool           `json:"think,omitempty"`
	Skills       string          `json:"skills"`
	SkillIDs     []string        `json:"skill_ids"`
	Chain        []string        `json:"chain,omitempty"`
}

type skillInput struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	Category     string `json:"category"`
	Instructions string `json:"instructions"`
}

type agentSaveReq struct {
	Agent *agentInput `json:"agent"`
}

type agentDeleteReq struct {
	AgentID string `json:"agent_id"`
}

type skillSaveReq struct {
	Skill *skillInput `json:"skill"`
}

type skillDeleteReq struct {
	SkillID string `json:"skill_id"`
}

type agentsMsg struct {
	Type   string          `json:"type"`
	ID     string          `json:"id"`
	Agents []history.Agent `json:"agents"`
}

type agentMsg struct {
	Type  string        `json:"type"`
	ID    string        `json:"id"`
	Agent history.Agent `json:"agent"`
}

type skillsMsg struct {
	Type   string          `json:"type"`
	ID     string          `json:"id"`
	Skills []history.Skill `json:"skills"`
}

type skillMsg struct {
	Type  string        `json:"type"`
	ID    string        `json:"id"`
	Skill history.Skill `json:"skill"`
}

// plainText checks one free-text field: valid UTF-8, at most max runes, no control characters
// (newlines and tabs only where multiline is allowed).
func plainText(field, v string, max int, multiline bool) error {
	if !utf8.ValidString(v) {
		return fmt.Errorf("%s is not valid UTF-8", field)
	}
	if utf8.RuneCountInString(v) > max {
		return fmt.Errorf("%s is longer than %d characters", field, max)
	}
	for _, r := range v {
		allowed := multiline && (r == '\n' || r == '\t' || r == '\r')
		if unicode.IsControl(r) && !allowed {
			return fmt.Errorf("%s has control characters", field)
		}
	}
	return nil
}

func validInstructions(v string) error {
	if !utf8.ValidString(v) {
		return errors.New("instructions are not valid UTF-8")
	}
	if len(v) > instructionsMaxBytes {
		return fmt.Errorf("instructions exceed %d bytes", instructionsMaxBytes)
	}
	return nil
}

// validateAgent checks every field and returns the agent to store (name trimmed, options
// re-encoded from the validated struct, skill ids deduplicated).
func validateAgent(in *agentInput) (history.Agent, error) {
	var a history.Agent
	if in == nil {
		return a, errors.New("agent is required")
	}
	if !history.IsValidUUID(in.ID) {
		return a, errors.New("agent.id must be a UUID")
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return a, errors.New("agent.name is required")
	}
	if err := plainText("agent.name", name, nameMaxRunes, false); err != nil {
		return a, err
	}
	if err := plainText("agent.description", in.Description, agentDescriptionMaxRunes, true); err != nil {
		return a, err
	}
	if len(in.Icon) > 40 || (in.Icon != "" && !iconPattern.MatchString(in.Icon)) {
		return a, errors.New("agent.icon is not an icon name")
	}
	if err := ollama.ValidateModelName(in.Model); err != nil {
		return a, errors.New("agent.model is not a model name")
	}
	if err := validInstructions(in.Instructions); err != nil {
		return a, err
	}
	opts, err := ollama.ParseChatOptions(in.Options)
	if err != nil {
		return a, err
	}
	var options json.RawMessage
	if opts != nil {
		if options, err = json.Marshal(opts); err != nil {
			return a, err
		}
		if string(options) == "{}" {
			options = nil
		}
	}
	if !skillsModes[in.Skills] {
		return a, errors.New("agent.skills must be off, all or selected")
	}
	if len(in.SkillIDs) > maxSkillIDs {
		return a, errors.New("too many skill_ids")
	}
	ids := make([]string, 0, len(in.SkillIDs))
	seen := map[string]bool{}
	for _, id := range in.SkillIDs {
		if !history.IsValidUUID(id) {
			return a, errors.New("skill_ids must be UUIDs")
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	chain, err := validateChainIDs(in.ID, in.Chain)
	if err != nil {
		return a, err
	}
	return history.Agent{ID: in.ID, Name: name, Description: in.Description, Icon: in.Icon, Model: in.Model,
		Instructions: in.Instructions, Options: options, Think: in.Think, Skills: in.Skills, SkillIDs: ids, Chain: chain}, nil
}

// validateChainIDs checks agent.chain: at most maxChain other agents (UUIDs), each once, in order.
// Whether they exist is the browser's business (a deleted agent leaves every chain, history.DeleteAgent).
func validateChainIDs(self string, chain []string) ([]string, error) {
	if len(chain) > maxChain {
		return nil, fmt.Errorf("agent.chain has more than %d agents", maxChain)
	}
	out := make([]string, 0, len(chain))
	seen := map[string]bool{}
	for _, id := range chain {
		if !history.IsValidUUID(id) {
			return nil, errors.New("agent.chain must be agent UUIDs")
		}
		if id == self {
			return nil, errors.New("an agent cannot follow itself in its chain")
		}
		if seen[id] {
			return nil, errors.New("agent.chain repeats an agent")
		}
		seen[id] = true
		out = append(out, id)
	}
	return out, nil
}

// validateChainSteps checks chat.chain: the answers of the agents before the last one, kept with
// the assistant message (SPEC §9.4).
func validateChainSteps(steps []chainStepInput) ([]history.ChainStep, string) {
	if len(steps) > maxChain {
		return nil, fmt.Sprintf("chain has more than %d steps", maxChain)
	}
	out := make([]history.ChainStep, 0, len(steps))
	for _, st := range steps {
		if !history.IsValidUUID(st.AgentID) {
			return nil, "chain.agent_id must be a UUID"
		}
		name := strings.TrimSpace(st.Name)
		if name == "" {
			return nil, "chain.name is required"
		}
		if err := plainText("chain.name", name, nameMaxRunes, false); err != nil {
			return nil, err.Error()
		}
		if err := ollama.ValidateModelName(st.Model); err != nil {
			return nil, "chain.model is not a model name"
		}
		if !utf8.ValidString(st.Content) || len(st.Content) > chainStepMaxBytes {
			return nil, fmt.Sprintf("chain.content must be UTF-8 of at most %d bytes", chainStepMaxBytes)
		}
		out = append(out, history.ChainStep{AgentID: st.AgentID, Name: name, Model: st.Model, Content: st.Content})
	}
	return out, ""
}

func validateSkill(in *skillInput) (history.Skill, error) {
	var k history.Skill
	if in == nil {
		return k, errors.New("skill is required")
	}
	if !history.IsValidUUID(in.ID) {
		return k, errors.New("skill.id must be a UUID")
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return k, errors.New("skill.name is required")
	}
	if err := plainText("skill.name", name, nameMaxRunes, false); err != nil {
		return k, err
	}
	if err := plainText("skill.description", in.Description, skillDescriptionMaxRunes, true); err != nil {
		return k, err
	}
	if !skillCategories[in.Category] {
		return k, errors.New("skill.category is not a category")
	}
	if err := validInstructions(in.Instructions); err != nil {
		return k, err
	}
	return history.Skill{ID: in.ID, Name: name, Description: in.Description, Category: in.Category, Instructions: in.Instructions}, nil
}

// validateSetup checks chat.agent_id / chat.skill_ids (what the conversation records).
func validateSetup(agentID string, skillIDs []string) string {
	if agentID != "" && !history.IsValidUUID(agentID) {
		return "agent_id must be a UUID"
	}
	if len(skillIDs) > maxSkillIDs {
		return "too many skill_ids"
	}
	for _, id := range skillIDs {
		if !history.IsValidUUID(id) {
			return "skill_ids must be UUIDs"
		}
	}
	return ""
}

func (m *Manager) handleAgentList(s *session, id string) {
	ctx, cancel := withTimeout()
	defer cancel()
	agents, err := m.cfg.History.ListAgents(ctx)
	if err != nil {
		m.log.Warn("agent_list", "err", err)
		m.sendError(s, id, ErrInternal, "")
		return
	}
	m.send(s, agentsMsg{Type: "agents", ID: id, Agents: agents})
}

func (m *Manager) handleAgentSave(s *session, id string, raw []byte) {
	var req agentSaveReq
	if err := decode(raw, &req); err != nil {
		m.sendError(s, id, ErrInvalid, "")
		return
	}
	agent, err := validateAgent(req.Agent)
	if err != nil {
		m.sendError(s, id, ErrInvalid, err.Error())
		return
	}
	ctx, cancel := withTimeout()
	defer cancel()
	saved, err := m.cfg.History.SaveAgent(ctx, agent)
	if errors.Is(err, history.ErrLimit) {
		m.sendError(s, id, ErrInvalid, fmt.Sprintf("at most %d agents", history.MaxAgents))
		return
	}
	if err != nil {
		m.log.Warn("agent_save", "err", err)
		m.sendError(s, id, ErrInternal, "")
		return
	}
	m.send(s, agentMsg{Type: "agent", ID: id, Agent: *saved})
}

func (m *Manager) handleAgentDelete(s *session, id string, raw []byte) {
	var req agentDeleteReq
	if err := decode(raw, &req); err != nil || !history.IsValidUUID(req.AgentID) {
		m.sendError(s, id, ErrInvalid, "")
		return
	}
	ctx, cancel := withTimeout()
	defer cancel()
	m.replyDeleted(s, id, "agent_delete", m.cfg.History.DeleteAgent(ctx, req.AgentID))
}

func (m *Manager) handleSkillList(s *session, id string) {
	ctx, cancel := withTimeout()
	defer cancel()
	skills, err := m.cfg.History.ListSkills(ctx)
	if err != nil {
		m.log.Warn("skill_list", "err", err)
		m.sendError(s, id, ErrInternal, "")
		return
	}
	m.send(s, skillsMsg{Type: "skills", ID: id, Skills: skills})
}

func (m *Manager) handleSkillSave(s *session, id string, raw []byte) {
	var req skillSaveReq
	if err := decode(raw, &req); err != nil {
		m.sendError(s, id, ErrInvalid, "")
		return
	}
	skill, err := validateSkill(req.Skill)
	if err != nil {
		m.sendError(s, id, ErrInvalid, err.Error())
		return
	}
	ctx, cancel := withTimeout()
	defer cancel()
	saved, err := m.cfg.History.SaveSkill(ctx, skill)
	if errors.Is(err, history.ErrLimit) {
		m.sendError(s, id, ErrInvalid, fmt.Sprintf("at most %d skills", history.MaxSkills))
		return
	}
	if err != nil {
		m.log.Warn("skill_save", "err", err)
		m.sendError(s, id, ErrInternal, "")
		return
	}
	m.send(s, skillMsg{Type: "skill", ID: id, Skill: *saved})
}

func (m *Manager) handleSkillDelete(s *session, id string, raw []byte) {
	var req skillDeleteReq
	if err := decode(raw, &req); err != nil || !history.IsValidUUID(req.SkillID) {
		m.sendError(s, id, ErrInvalid, "")
		return
	}
	ctx, cancel := withTimeout()
	defer cancel()
	m.replyDeleted(s, id, "skill_delete", m.cfg.History.DeleteSkill(ctx, req.SkillID))
}

func (m *Manager) replyDeleted(s *session, id, what string, err error) {
	switch {
	case err == nil:
		m.send(s, okMsg{Type: "ok", ID: id})
	case errors.Is(err, history.ErrNotFound):
		m.sendError(s, id, ErrNotFound, "")
	default:
		m.log.Warn(what, "err", err)
		m.sendError(s, id, ErrInternal, "")
	}
}
