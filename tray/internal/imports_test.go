// Package internal_test enforces the tray's import rules (rule 4 in tray/README.md, "Layout and
// invariants"; a mirror of the depguard rules in .golangci.yml, so the invariant holds even without
// the linter):
//
//   - os/exec is imported ONLY by internal/system.
//   - net and net/http are never imported by internal/channel, internal/crypto,
//     internal/history or internal/pairing.
package internal_test

import (
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestImportRules(t *testing.T) {
	root, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	noNet := []string{"channel", "crypto", "history", "pairing"}
	checked := 0
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		pkgDir := strings.SplitN(rel, "/", 2)[0]
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		checked++
		for _, imp := range f.Imports {
			p, err := strconv.Unquote(imp.Path.Value)
			if err != nil {
				return err
			}
			if p == "os/exec" && pkgDir != "system" {
				t.Errorf("%s imports os/exec (allowed only in internal/system)", rel)
			}
			if p == "net" || p == "net/http" {
				for _, dir := range noNet {
					if pkgDir == dir {
						t.Errorf("%s imports %s (network only in internal/ollama, internal/relay and internal/localui)", rel, p)
					}
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if checked < 10 {
		t.Fatalf("only %d files checked; wrong working directory?", checked)
	}
	// Sanity: internal/system really is where os/exec lives.
	if _, err := os.Stat(filepath.Join(root, "system", "system.go")); err != nil {
		t.Fatalf("internal/system/system.go missing: %v", err)
	}
}
