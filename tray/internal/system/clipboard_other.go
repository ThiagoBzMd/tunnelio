//go:build !linux

package system

import "errors"

// copyNative: macOS and Windows are covered by the atotto/clipboard fallback (pbcopy / clip).
func copyNative(string) error { return errors.New("native clipboard not implemented on this OS") }
