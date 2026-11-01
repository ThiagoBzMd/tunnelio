package ollama

import "encoding/json"

// Named structs for everything Ollama returns. The JSON tags are Ollama's; these values are
// re-encoded by package channel into the SPEC §7.4 messages — never relayed as-is.

// ModelDetails mirrors Ollama's "details" object.
type ModelDetails struct {
	Family            string   `json:"family"`
	Families          []string `json:"families,omitempty"`
	ParameterSize     string   `json:"parameter_size"`
	QuantizationLevel string   `json:"quantization_level"`
	Format            string   `json:"format"`
}

// Model is one entry of GET /api/tags.
type Model struct {
	Name       string       `json:"name"`
	Size       int64        `json:"size"`
	ModifiedAt string       `json:"modified_at"`
	Digest     string       `json:"digest"`
	Details    ModelDetails `json:"details"`
}

// RunningModel is one entry of GET /api/ps.
type RunningModel struct {
	Name      string        `json:"name"`
	Size      int64         `json:"size"`
	SizeVRAM  int64         `json:"size_vram"`
	ExpiresAt string        `json:"expires_at"`
	Details   *ModelDetails `json:"details,omitempty"`
	// ContextLength is the context the model was loaded with (newer Ollama versions; 0 = not said).
	ContextLength int64 `json:"context_length,omitempty"`
}

// ModelInfo is the shaped result of POST /api/show (text fields already truncated).
type ModelInfo struct {
	Name          string
	Details       ModelDetails
	Capabilities  []string
	ContextLength *int64
	Parameters    string
	Template      string
	License       string
}

// showResponse is the raw POST /api/show body.
type showResponse struct {
	License      string                     `json:"license"`
	Parameters   string                     `json:"parameters"`
	Template     string                     `json:"template"`
	Details      ModelDetails               `json:"details"`
	Capabilities []string                   `json:"capabilities"`
	ModelInfo    map[string]json.RawMessage `json:"model_info"` // keys are "<arch>.<field>"; only two are read
}

// Message is one chat message sent to Ollama: role, content and (user messages only) the raw
// bytes of up to MaxImagesPerMessage images. encoding/json renders Images as standard padded
// base64, which is exactly what Ollama's "images" field expects; nothing else is ever attached
// (no tools, format, template or raw).
type Message struct {
	Role    string   `json:"role"`
	Content string   `json:"content"`
	Images  [][]byte `json:"images,omitempty"`
}

// ChatRequest is the validated input of Client.Chat.
type ChatRequest struct {
	Model     string
	Messages  []Message
	Options   *ChatOptions
	Think     *bool
	KeepAlive string // "", "0", "5m", "30m", "1h"
}

// Validate checks the model name, roles, images and keep_alive. Options are validated separately.
func (r ChatRequest) Validate() error {
	if err := ValidateModelName(r.Model); err != nil {
		return err
	}
	if len(r.Messages) == 0 {
		return ErrInvalid("messages must not be empty")
	}
	for _, m := range r.Messages {
		switch m.Role {
		case "system", "user", "assistant":
		default:
			return ErrInvalid("invalid message role")
		}
		if err := validateImages(m); err != nil {
			return err
		}
	}
	switch r.KeepAlive {
	case "", "0", "5m", "30m", "1h":
	default:
		return ErrInvalid("invalid keep_alive")
	}
	if r.Options != nil {
		if err := r.Options.Validate(); err != nil {
			return err
		}
	}
	return nil
}

// chatWire is the exact body sent to POST /api/chat (SPEC §8.1).
type chatWire struct {
	Model     string       `json:"model"`
	Messages  []Message    `json:"messages"`
	Stream    bool         `json:"stream"`
	Options   *ChatOptions `json:"options,omitempty"`
	Think     *bool        `json:"think,omitempty"`
	KeepAlive string       `json:"keep_alive,omitempty"`
}

// ToolCall mirrors Ollama's tool_calls item. We never send tools; if one comes back it is
// serialized as text into the chunk content.
type ToolCall struct {
	Function ToolCallFunction `json:"function"`
}

// ToolCallFunction is the function part of a ToolCall.
type ToolCallFunction struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

// chatLine is one NDJSON line of POST /api/chat.
type chatLine struct {
	Model   string `json:"model"`
	Message struct {
		Role      string     `json:"role"`
		Content   string     `json:"content"`
		Thinking  string     `json:"thinking"`
		ToolCalls []ToolCall `json:"tool_calls"`
	} `json:"message"`
	Done               bool   `json:"done"`
	DoneReason         string `json:"done_reason"`
	TotalDuration      int64  `json:"total_duration"`
	LoadDuration       int64  `json:"load_duration"`
	PromptEvalCount    int64  `json:"prompt_eval_count"`
	PromptEvalDuration int64  `json:"prompt_eval_duration"`
	EvalCount          int64  `json:"eval_count"`
	EvalDuration       int64  `json:"eval_duration"`
	Error              string `json:"error"`
}

// ChatChunk is one streamed delta.
type ChatChunk struct {
	Content  string
	Thinking string
}

// ChatStats are the final counters of a chat (ns and counts as Ollama reports them).
type ChatStats struct {
	TotalDuration      int64 `json:"total_duration"`
	LoadDuration       int64 `json:"load_duration"`
	PromptEvalCount    int64 `json:"prompt_eval_count"`
	PromptEvalDuration int64 `json:"prompt_eval_duration"`
	EvalCount          int64 `json:"eval_count"`
	EvalDuration       int64 `json:"eval_duration"`
}

// ChatResult is returned when the stream completes.
type ChatResult struct {
	DoneReason string // "stop" or "length" as reported by Ollama
	Stats      ChatStats
}

// pullWire is the exact body sent to POST /api/pull (never insecure).
type pullWire struct {
	Model  string `json:"model"`
	Stream bool   `json:"stream"`
}

// pullLine is one NDJSON line of POST /api/pull.
type pullLine struct {
	Status    string `json:"status"`
	Digest    string `json:"digest"`
	Total     int64  `json:"total"`
	Completed int64  `json:"completed"`
	Error     string `json:"error"`
}

// PullProgress is one progress event of Client.Pull.
type PullProgress struct {
	Status    string
	Digest    string
	Total     int64
	Completed int64
}

// ErrInvalid is a validation error (maps to E_INVALID).
type ErrInvalid string

func (e ErrInvalid) Error() string { return "ollama: invalid request: " + string(e) }
