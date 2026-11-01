package tray

import (
	"log/slog"

	"github.com/gen2brain/beeep"

	"github.com/ThiagoBzMd/tunnelio/tray/assets"
)

// AppName is shown by the OS notification center.
const AppName = "Tunnelio"

// Notifier sends local desktop notifications through beeep. It satisfies channel.Notifier.
type Notifier struct {
	Logger *slog.Logger
}

// Notify shows a notification; failures are only logged.
func (n Notifier) Notify(title, body string) {
	beeep.AppName = AppName
	if err := beeep.Notify(title, body, assets.IconPNG); err != nil && n.Logger != nil {
		n.Logger.Warn("notification failed", "err", err)
	}
}
