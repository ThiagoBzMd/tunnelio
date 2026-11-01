package system

import (
	"errors"
	"fmt"
	"runtime"

	"github.com/atotto/clipboard"
)

// CopyToClipboard puts text on the system clipboard, like Ctrl+C would.
//
//   - Linux: owns the X11/XWayland CLIPBOARD selection in pure Go (no xclip needed); falls back
//     to xclip / xsel / wl-copy when there is no X display (pure Wayland without XWayland).
//   - macOS: pbcopy. Windows: clip.exe. (atotto/clipboard)
func CopyToClipboard(text string) error {
	if text == "" {
		return errors.New("nothing to copy")
	}
	nativeErr := copyNative(text)
	if nativeErr == nil {
		return nil
	}
	if err := clipboard.WriteAll(text); err != nil {
		if runtime.GOOS == "linux" {
			return fmt.Errorf("clipboard unavailable (%v); install xclip, xsel or wl-clipboard", nativeErr)
		}
		return fmt.Errorf("clipboard unavailable: %w", err)
	}
	return nil
}
