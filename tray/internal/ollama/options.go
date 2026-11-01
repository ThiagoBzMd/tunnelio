package ollama

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// ChatOptions is the closed whitelist of chat options (SPEC §8.3). Pointer fields are sent
// only when set. Any other key is rejected by ParseChatOptions.
type ChatOptions struct {
	Temperature   *float64 `json:"temperature,omitempty"`
	TopP          *float64 `json:"top_p,omitempty"`
	TopK          *int     `json:"top_k,omitempty"`
	NumCtx        *int     `json:"num_ctx,omitempty"`
	NumPredict    *int     `json:"num_predict,omitempty"`
	RepeatPenalty *float64 `json:"repeat_penalty,omitempty"`
	Seed          *int64   `json:"seed,omitempty"`
	Stop          []string `json:"stop,omitempty"`
}

// ParseChatOptions decodes the raw "options" object, rejecting unknown keys, and validates ranges.
func ParseChatOptions(raw []byte) (*ChatOptions, error) {
	if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var o ChatOptions
	if err := dec.Decode(&o); err != nil {
		return nil, ErrInvalid("options: " + err.Error())
	}
	if dec.More() {
		return nil, ErrInvalid("options: trailing data")
	}
	if err := o.Validate(); err != nil {
		return nil, err
	}
	return &o, nil
}

// Validate enforces the ranges of SPEC §8.3.
func (o *ChatOptions) Validate() error {
	if o == nil {
		return nil
	}
	if o.Temperature != nil && (*o.Temperature < 0 || *o.Temperature > 2) {
		return ErrInvalid("temperature out of range")
	}
	if o.TopP != nil && (*o.TopP < 0 || *o.TopP > 1) {
		return ErrInvalid("top_p out of range")
	}
	if o.TopK != nil && (*o.TopK < 1 || *o.TopK > 1000) {
		return ErrInvalid("top_k out of range")
	}
	if o.NumCtx != nil && (*o.NumCtx < 512 || *o.NumCtx > 262144) {
		return ErrInvalid("num_ctx out of range")
	}
	if o.NumPredict != nil && *o.NumPredict != -1 && (*o.NumPredict < 1 || *o.NumPredict > 131072) {
		return ErrInvalid("num_predict out of range")
	}
	if o.RepeatPenalty != nil && (*o.RepeatPenalty < 0 || *o.RepeatPenalty > 3) {
		return ErrInvalid("repeat_penalty out of range")
	}
	if o.Seed != nil && (*o.Seed < 0 || *o.Seed > 1<<31-1) {
		return ErrInvalid("seed out of range")
	}
	if len(o.Stop) > 8 {
		return ErrInvalid("stop: too many items")
	}
	for i, s := range o.Stop {
		if len(s) > 64 {
			return ErrInvalid(fmt.Sprintf("stop[%d]: too long", i))
		}
	}
	return nil
}
