package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"runtime"
	"sync"
	"time"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/channel"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/config"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/history"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/localui"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/ollama"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/pairing"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/relay"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/system"
	"github.com/ThiagoBzMd/tunnelio/tray/internal/tray"
)

// headlessRetryDelay is the pause before a new code is generated after a failed pairing when
// the headless device is still unpaired.
const headlessRetryDelay = 5 * time.Second

// app wires every package together.
type app struct {
	opts   *options
	paths  config.Paths
	cfg    *config.Config
	log    *slog.Logger
	stdout io.Writer

	mu          sync.Mutex
	device      *config.Device
	ollamaState system.OllamaStatus
	relayState  relay.State
	pairOnce    bool // --pair still pending

	pairings *config.Pairings
	ollama   *ollama.Client
	history  *history.Store
	manager  *channel.Manager
	pairer   *pairing.Pairer
	relay    *relay.Client
	ui       *tray.UI
	local    *localui.Server
	strings  tray.Strings
	notifier channel.Notifier
	updates  updateState

	cancel context.CancelFunc
}

func platform() string {
	switch runtime.GOOS {
	case "windows":
		return "windows"
	case "darwin":
		return "macos"
	default:
		return "linux"
	}
}

func newApp(opts *options, logger *slog.Logger, stdout io.Writer) (*app, error) {
	dir, err := config.ResolveDir(opts.configDir)
	if err != nil {
		return nil, err
	}
	paths := config.NewPaths(dir)
	cfg, err := config.LoadConfig(paths)
	if err != nil {
		return nil, err
	}
	cfg.ApplyEnv()
	if opts.server != "" {
		cfg.ServerURL = opts.server
	}
	if opts.ollamaURL != "" {
		cfg.OllamaURL = opts.ollamaURL
	}
	if cfg.ServerURL == "" {
		cfg.ServerURL = defaultServerURL
	}
	a := &app{opts: opts, paths: paths, cfg: cfg, log: logger, stdout: stdout, pairOnce: opts.pair}

	a.device, err = config.LoadDevice(paths)
	if err != nil {
		return nil, err
	}
	a.pairings, err = config.LoadPairings(paths)
	if err != nil {
		return nil, err
	}
	a.ollama, err = ollama.New(cfg.OllamaURL, ollama.Options{AllowNonLoopback: cfg.AllowNonLoopbackOllama})
	if err != nil {
		return nil, err
	}
	a.history, err = history.Open(paths.HistoryFile)
	if err != nil {
		return nil, err
	}
	if opts.headless {
		a.notifier = logNotifier{logger}
	} else {
		a.notifier = tray.Notifier{Logger: logger}
	}
	a.manager = channel.New(channel.Config{
		Transport:    relayTransport{a},
		Pairings:     a.pairings,
		Ollama:       a.ollama,
		History:      a.history,
		Notifier:     a.notifier,
		Logger:       logger,
		TrayVersion:  version,
		Platform:     platform(),
		OllamaStatus: a.ollamaStatus,
		OnHandshake:  func(clientID string) { a.printf("SESSION %s handshake ok\n", clientID) },
	})
	if a.device != nil {
		if err := a.manager.SetDeviceID(a.device.DeviceID); err != nil {
			return nil, fmt.Errorf("device.json: %w", err)
		}
	}
	a.pairer = pairing.New(pairing.Config{
		Transport:  pairerTransport{a},
		Store:      a.pairings,
		DeviceName: cfg.DeviceName,
		Logger:     logger,
		OnCode:     a.onPairingCode,
		OnResult:   a.onPairingResult,
		OnPaired:   a.onPaired,
	})
	if cfg.ServerURL != "" {
		a.relay, err = relay.New(relay.Config{
			ServerURL: cfg.ServerURL,
			Token:     a.token,
			Version:   version,
			Platform:  platform(),
			Logger:    logger,
			Handlers:  a.relayHandlers(),
		})
		if err != nil {
			return nil, err
		}
	}
	a.strings = tray.StringsFor(localui.DetectLang())
	if !opts.headless {
		a.ui = tray.New(logger, a.actions(), a.notifier.Notify)
		a.local = localui.New(a.localHooks(), localui.DetectLang())
	}
	logger.Info("tunnelio starting", "version", version, "platform", platform(), "config_dir", dir,
		"server_url", cfg.ServerURL, "ollama_url", cfg.OllamaURL, "paired", a.device != nil,
		"pairings", a.pairings.Count(), "headless", opts.headless)
	return a, nil
}

// printf writes the stable headless marker lines (parsed by humans and e2e tests).
func (a *app) printf(format string, args ...any) {
	_, _ = fmt.Fprintf(a.stdout, format, args...)
}

func (a *app) close() {
	if a.history != nil {
		_ = a.history.Close()
		if a.local != nil {
			a.local.Close()
		}
	}
}

// run blocks until ctx is done (headless) or the tray quits.
func (a *app) run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	a.cancel = cancel
	defer cancel()

	a.detectOllama(ctx)
	if a.relay == nil {
		a.log.Error("no server URL configured: set it in config.json (server_url), TUNNELIO_SERVER_URL or --server")
		if a.opts.headless {
			return errors.New("server URL not configured")
		}
		a.notifier.Notify(tray.AppName, "Server URL not configured. Use 'Server URL…' in the menu.")
	}
	var wg sync.WaitGroup
	if a.relay != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = a.relay.Run(ctx)
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		a.watchOllama(ctx)
	}()

	if a.opts.headless {
		<-ctx.Done()
	} else {
		a.firstRunAutostartPrompt()
		a.pushStatus()
		err := a.ui.Run(ctx)
		a.ui.Quitting() // the native loop is gone: no more menu updates during shutdown
		if err != nil {
			a.log.Error("tray", "err", err)
			cancel()
			wg.Wait()
			return err
		}
		cancel()
	}
	wg.Wait()
	a.log.Info("tunnelio stopped")
	return nil
}
