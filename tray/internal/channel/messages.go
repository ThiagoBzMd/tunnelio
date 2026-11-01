package channel

import (
	"encoding/json"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/history"
)

// Wire structs. JSON field names are exactly those of SPEC §5.1, §6.1, §7.3 and §7.4.

// ProtocolVersion is the only version implemented.
const ProtocolVersion = 1

// Application error codes (SPEC §7.5).
const (
	ErrInvalid       = "E_INVALID"
	ErrBusy          = "E_BUSY"
	ErrRateLimit     = "E_RATE_LIMIT"
	ErrTooLarge      = "E_TOO_LARGE"
	ErrOllamaDown    = "E_OLLAMA_DOWN"
	ErrOllamaError   = "E_OLLAMA_ERROR"
	ErrModelNotFound = "E_MODEL_NOT_FOUND"
	ErrBadModelName  = "E_BAD_MODEL_NAME"
	ErrNotFound      = "E_NOT_FOUND"
	ErrPullBusy      = "E_PULL_BUSY"
	ErrInternal      = "E_INTERNAL"
)

// Handshake reject codes (SPEC §5.1).
const (
	RejectUnknownPairing = "E_UNKNOWN_PAIRING"
	RejectVersion        = "E_VERSION"
	RejectBusy           = "E_BUSY"
)

// payload is the union of a handshake message (hs != "") and an envelope (ciphertext != "").
type payload struct {
	V          int    `json:"v"`
	HS         string `json:"hs,omitempty"`
	PairingID  string `json:"pairing_id,omitempty"`
	EphPub     string `json:"eph_pub,omitempty"`
	MAC        string `json:"mac,omitempty"`
	Code       string `json:"code,omitempty"`
	DeviceID   string `json:"device_id,omitempty"`
	Nonce      string `json:"nonce,omitempty"`
	Ciphertext string `json:"ciphertext,omitempty"`
}

type helloAckMsg struct {
	V      int    `json:"v"`
	HS     string `json:"hs"`
	EphPub string `json:"eph_pub"`
	MAC    string `json:"mac"`
}

type rejectMsg struct {
	V    int    `json:"v"`
	HS   string `json:"hs"`
	Code string `json:"code"`
}

type envelopeMsg struct {
	V          int    `json:"v"`
	DeviceID   string `json:"device_id"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

// ─── requests (browser → tray) ───────────────────────────────────────────────

type requestHead struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type showModelReq struct {
	Name string `json:"name"`
}

// chatMessage is one item of chat.messages. Images are standard base64 (padded or not, no
// data-URL prefix) of raw JPEG/PNG/WebP/GIF bytes and are accepted only with role "user".
type chatMessage struct {
	Role    string   `json:"role"`
	Content string   `json:"content"`
	Images  []string `json:"images,omitempty"`
}

type chatReq struct {
	ConversationID string          `json:"conversation_id"`
	Mode           string          `json:"mode"`
	Model          string          `json:"model"`
	Messages       []chatMessage   `json:"messages"`
	Options        json.RawMessage `json:"options,omitempty"`
	Think          *bool           `json:"think,omitempty"`
	Title          string          `json:"title,omitempty"`
	KeepAlive      string          `json:"keep_alive,omitempty"`
	// AgentID / SkillIDs (rev. 1.8): what the browser applied to this turn (it composes the system
	// message itself); recorded on the conversation so reopening it applies them again.
	AgentID  string   `json:"agent_id,omitempty"`
	SkillIDs []string `json:"skill_ids,omitempty"`
	// Chain (rev. 1.9): with an agent chain, what the agents before this last one answered; kept with
	// the assistant message (SPEC §9.4).
	Chain []chainStepInput `json:"chain,omitempty"`
}

// chainStepInput is one item of chat.chain.
type chainStepInput struct {
	AgentID string `json:"agent_id"`
	Name    string `json:"name"`
	Model   string `json:"model"`
	Content string `json:"content"`
}

type abortReq struct {
	TargetID string `json:"target_id"`
}

type pullModelReq struct {
	Name string `json:"name"`
}

type deleteModelReq struct {
	Name string `json:"name"`
}

type historyListReq struct {
	Limit  *int   `json:"limit,omitempty"`
	Before string `json:"before,omitempty"`
}

type historyGetReq struct {
	ConversationID string `json:"conversation_id"`
	AfterSeq       *int64 `json:"after_seq,omitempty"`
	Limit          *int   `json:"limit,omitempty"`
}

type historyDeleteReq struct {
	ConversationID string `json:"conversation_id"`
}

// ─── responses and events (tray → browser) ───────────────────────────────────

type deviceInfoMsg struct {
	Type             string     `json:"type"`
	ProtocolVersions []int      `json:"protocol_versions"`
	TrayVersion      string     `json:"tray_version"`
	Platform         string     `json:"platform"`
	Ollama           ollamaInfo `json:"ollama"`
	Limits           limitsInfo `json:"limits"`
	Capabilities     []string   `json:"capabilities"`
	// Pull (rev. 1.9): the model this computer is downloading right now, so a browser that comes back
	// can join it (pull_model with the same name) and follow its progress.
	Pull *pullInfo `json:"pull,omitempty"`
}

type pullInfo struct {
	Name string `json:"name"`
}

type ollamaInfo struct {
	Status  string `json:"status"`
	Version string `json:"version,omitempty"`
}

type limitsInfo struct {
	MaxMessageBytes     int `json:"max_message_bytes"`
	ChatConcurrency     int `json:"chat_concurrency"`
	PullConcurrency     int `json:"pull_concurrency"`
	MaxImagesPerMessage int `json:"max_images_per_message"`
	MaxImageBytes       int `json:"max_image_bytes"`
}

type modelDetails struct {
	Family            string   `json:"family"`
	Families          []string `json:"families,omitempty"`
	ParameterSize     string   `json:"parameter_size"`
	QuantizationLevel string   `json:"quantization_level"`
	Format            string   `json:"format"`
}

type modelEntry struct {
	Name       string       `json:"name"`
	Size       int64        `json:"size"`
	ModifiedAt string       `json:"modified_at"`
	Digest     string       `json:"digest"`
	Details    modelDetails `json:"details"`
}

type modelsMsg struct {
	Type   string       `json:"type"`
	ID     string       `json:"id"`
	Models []modelEntry `json:"models"`
}

type runningEntry struct {
	Name      string        `json:"name"`
	Size      int64         `json:"size"`
	SizeVRAM  int64         `json:"size_vram"`
	ExpiresAt string        `json:"expires_at"`
	Details   *modelDetails `json:"details,omitempty"`
	// ContextLength (rev. 1.9): the context the model is loaded with, when Ollama says (SPEC §7.7).
	ContextLength *int64 `json:"context_length,omitempty"`
}

type runningMsg struct {
	Type   string         `json:"type"`
	ID     string         `json:"id"`
	Models []runningEntry `json:"models"`
}

type modelInfoMsg struct {
	Type          string       `json:"type"`
	ID            string       `json:"id"`
	Name          string       `json:"name"`
	Details       modelDetails `json:"details"`
	Capabilities  []string     `json:"capabilities,omitempty"`
	ContextLength *int64       `json:"context_length,omitempty"`
	Parameters    string       `json:"parameters,omitempty"`
	Template      string       `json:"template,omitempty"`
	License       string       `json:"license,omitempty"`
}

type chatChunkMsg struct {
	Type     string `json:"type"`
	ID       string `json:"id"`
	Content  string `json:"content"`
	Thinking string `json:"thinking,omitempty"`
}

type statsMsg struct {
	TotalDuration      int64 `json:"total_duration"`
	LoadDuration       int64 `json:"load_duration"`
	PromptEvalCount    int64 `json:"prompt_eval_count"`
	PromptEvalDuration int64 `json:"prompt_eval_duration"`
	EvalCount          int64 `json:"eval_count"`
	EvalDuration       int64 `json:"eval_duration"`
}

type chatDoneMsg struct {
	Type           string    `json:"type"`
	ID             string    `json:"id"`
	ConversationID string    `json:"conversation_id"`
	DoneReason     string    `json:"done_reason"`
	Stats          *statsMsg `json:"stats,omitempty"`
	MessageID      string    `json:"message_id,omitempty"`
}

type pullProgressMsg struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	Status    string `json:"status"`
	Total     *int64 `json:"total,omitempty"`
	Completed *int64 `json:"completed,omitempty"`
}

type pullDoneMsg struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Name string `json:"name"`
}

type historyMsg struct {
	Type          string                 `json:"type"`
	ID            string                 `json:"id"`
	Conversations []history.Conversation `json:"conversations"`
	HasMore       bool                   `json:"has_more"`
	// Totals of this computer's conversation file (rev. 1.4): shown in Settings → Conversations.
	TotalConversations int64 `json:"total_conversations"`
	TotalBytes         int64 `json:"total_bytes"`
}

type conversationHead struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Model     string   `json:"model"`
	CreatedAt string   `json:"created_at"`
	UpdatedAt string   `json:"updated_at"`
	AgentID   string   `json:"agent_id,omitempty"`
	SkillIDs  []string `json:"skill_ids,omitempty"`
}

type conversationMsg struct {
	Type         string            `json:"type"`
	ID           string            `json:"id"`
	Conversation conversationHead  `json:"conversation"`
	Messages     []history.Message `json:"messages"`
	HasMore      bool              `json:"has_more"`
}

type okMsg struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type errorMsg struct {
	Type         string `json:"type"`
	ID           string `json:"id,omitempty"`
	Code         string `json:"code"`
	Message      string `json:"message,omitempty"`
	RetryAfterMS *int64 `json:"retry_after_ms,omitempty"`
}
