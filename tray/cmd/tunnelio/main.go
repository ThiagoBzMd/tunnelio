// Command tunnelio is the Tunnelio tray app.
//
// Wiring: config → ollama client + history → channel manager + pairer → relay client → tray
// menu (or headless loop). The relay only ever receives opaque payloads from package channel
// and package pairing; system actions are reachable from the tray menu alone.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/config"
)

// defaultServerURL is injected at release time with
//
//	-ldflags "-X main.defaultServerURL=https://..."
//
// so that no hostname lives in the source tree. Empty = must be configured (config.json,
// TUNNELIO_SERVER_URL or --server).
var defaultServerURL = ""

// version is injected by GoReleaser (-X main.version={{.Version}}).
var version = "dev"

// options are the command-line flags.
type options struct {
	headless    bool
	configDir   string
	server      string
	ollamaURL   string
	pair        bool
	showVersion bool
}

func parseArgs(args []string, stderr io.Writer) (*options, error) {
	o := &options{}
	fs := flag.NewFlagSet("tunnelio", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.BoolVar(&o.headless, "headless", os.Getenv("TUNNELIO_HEADLESS") == "1", "run without the system tray (logs to stdout)")
	fs.StringVar(&o.configDir, "config-dir", "", "configuration directory (default: user config dir/tunnelio; env TUNNELIO_CONFIG_DIR)")
	fs.StringVar(&o.server, "server", "", "relay server URL, e.g. https://app.example.com (env TUNNELIO_SERVER_URL)")
	fs.StringVar(&o.ollamaURL, "ollama", "", "Ollama base URL (default http://127.0.0.1:11434; env TUNNELIO_OLLAMA_URL)")
	fs.BoolVar(&o.pair, "pair", false, "start a pairing immediately after connecting")
	fs.BoolVar(&o.showVersion, "version", false, "print the version and exit")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	return o, nil
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			os.Exit(2)
		}
		fmt.Fprintln(os.Stderr, "tunnelio:", err)
		os.Exit(1)
	}
}

// run is the whole program; main only adds signals and the exit code. Tests call it directly.
func run(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	opts, err := parseArgs(args, stderr)
	if err != nil {
		return err
	}
	if opts.showVersion {
		_, _ = fmt.Fprintf(stdout, "tunnelio %s\n", version)
		return nil
	}
	level := slog.LevelInfo
	if strings.EqualFold(os.Getenv("TUNNELIO_LOG_LEVEL"), "debug") {
		level = slog.LevelDebug
	}
	logOut := stdout
	if !opts.headless {
		// GUI mode: no console on Windows (-H=windowsgui) and none worth reading elsewhere, so the
		// log goes to <config dir>/tray.log (truncated at every start; mode 0600).
		if f := openLogFile(opts.configDir); f != nil {
			defer func() { _ = f.Close() }()
			logOut = f
		}
	}
	logger := slog.New(slog.NewTextHandler(logOut, &slog.HandlerOptions{Level: level}))

	a, err := newApp(opts, logger, stdout)
	if err != nil {
		return err
	}
	defer a.close()
	return a.run(ctx)
}

// openLogFile returns <config dir>/tray.log for writing, or nil when it cannot be opened (the
// log then stays on stdout). Secrets are never logged, so 0600 is belt and braces.
func openLogFile(configDirOverride string) *os.File {
	dir, err := config.ResolveDir(configDirOverride)
	if err != nil {
		return nil
	}
	path := filepath.Join(dir, "tray.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600) //nolint:gosec // our own config dir
	if err != nil {
		return nil
	}
	config.CloseToOthers(path) // a log created earlier keeps its old mode
	return f
}
