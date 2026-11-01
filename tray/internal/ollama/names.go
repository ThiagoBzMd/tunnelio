package ollama

import (
	"errors"
	"regexp"
)

// Model name rules (SPEC §8.2).

const maxModelNameLen = 256

var (
	// modelNameRe is the general regex applied to show_model, chat and delete_model.
	modelNameRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9._-]{0,63})?(/[a-z0-9]([a-z0-9._-]{0,63})?)?(:[a-zA-Z0-9][a-zA-Z0-9._-]{0,63})?$`)
	// pullNameRe is the strict form for pull_model: family:tag or namespace/family:tag, tag mandatory.
	pullNameRe = regexp.MustCompile(`^([a-z0-9]([a-z0-9._-]{0,63})?/)?[a-z0-9]([a-z0-9._-]{0,63})?:[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`)
)

// ErrBadModelName maps to E_BAD_MODEL_NAME.
var ErrBadModelName = errors.New("ollama: invalid model name")

// ValidateModelName checks a name for show_model, chat and delete_model.
func ValidateModelName(name string) error {
	if len(name) == 0 || len(name) > maxModelNameLen || !modelNameRe.MatchString(name) {
		return ErrBadModelName
	}
	return nil
}

// ValidatePullName checks the strict pull_model form (tag required, no @sha256:).
func ValidatePullName(name string) error {
	if len(name) == 0 || len(name) > maxModelNameLen || !pullNameRe.MatchString(name) {
		return ErrBadModelName
	}
	return nil
}
