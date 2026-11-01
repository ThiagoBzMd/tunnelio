// The update notice: the relay's welcome may announce the newest computer-app release (SPEC
// §3.4). When it is newer than this build, the menu offers it and a notification says so, once
// per version. Builds from source ("dev…") never ask (package release).
package main

import (
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/relay"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/release"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/system"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/tray"
)

type updateState struct {
	mu       sync.Mutex
	version  string // the newer release on offer ("" = none)
	url      string // its download page (https only)
	notified string // the version already announced in a notification
}

// onLatest takes the relay's announcement (nil: none, which also withdraws an earlier offer).
func (a *app) onLatest(l *relay.Latest) {
	offer, url := "", ""
	if l != nil && strings.HasPrefix(l.URL, "https://") && release.Newer(version, l.Version) {
		offer, url = l.Version, l.URL
	}
	a.updates.mu.Lock()
	notify := offer != "" && offer != a.updates.notified
	a.updates.version, a.updates.url = offer, url
	if notify {
		a.updates.notified = offer
	}
	a.updates.mu.Unlock()
	if notify {
		a.log.Info("update available", "version", offer)
		a.notifier.Notify(tray.AppName, fmt.Sprintf(a.strings.UpdateFmt, offer))
	}
}

// updateOffer is the newer release on offer and its download page ("" when there is none).
func (a *app) updateOffer() (ver, url string) {
	a.updates.mu.Lock()
	defer a.updates.mu.Unlock()
	return a.updates.version, a.updates.url
}

func (a *app) openUpdatePage() error {
	_, url := a.updateOffer()
	if url == "" {
		return errors.New("no update available")
	}
	return system.OpenURL(url)
}
