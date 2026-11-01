//go:build headless

package tray

import (
	"context"
	"errors"
)

// ErrNoSystray is returned by UI.Run in binaries built with -tags headless.
var ErrNoSystray = errors.New("tray: built without systray (-tags headless); use --headless")

// menuItems is empty in headless builds; render is a no-op.
type menuItems struct{}

func (m *menuItems) render(Status) {}

func (u *UI) run(context.Context) error { return ErrNoSystray }
