// Package release compares the tray's own version with the newest release the relay announces in
// its welcome (SPEC §3.4), so the menu can offer the update.
package release

import (
	"strconv"
	"strings"
)

// Newer reports whether latest is a newer release than current. Both are release versions
// ("1.2.3", optionally "v"-prefixed, optionally with a pre-release such as "-rc.2"); anything
// else — a build from source ("dev", "dev-abc1234") or an unparsable string — is never compared,
// so such a build never asks to be updated.
func Newer(current, latest string) bool {
	c, ok1 := parse(current)
	l, ok2 := parse(latest)
	return ok1 && ok2 && compare(l, c) > 0
}

type semver struct {
	core [3]int
	pre  []string // empty for a release
}

func parse(s string) (semver, bool) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	if i := strings.IndexByte(s, '+'); i >= 0 { // build metadata does not count
		s = s[:i]
	}
	var v semver
	core, pre, hasPre := strings.Cut(s, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return v, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || p == "" {
			return v, false
		}
		v.core[i] = n
	}
	if hasPre {
		if pre == "" {
			return v, false
		}
		v.pre = strings.Split(pre, ".")
	}
	return v, true
}

// compare follows semver precedence: the numbers first; a pre-release comes before its release;
// pre-release fields compare numerically when both are numbers, as text otherwise (numbers first).
func compare(a, b semver) int {
	for i := range a.core {
		if a.core[i] != b.core[i] {
			return sign(a.core[i] - b.core[i])
		}
	}
	switch {
	case len(a.pre) == 0 && len(b.pre) == 0:
		return 0
	case len(a.pre) == 0:
		return 1
	case len(b.pre) == 0:
		return -1
	}
	for i := 0; i < len(a.pre) && i < len(b.pre); i++ {
		x, errX := strconv.Atoi(a.pre[i])
		y, errY := strconv.Atoi(b.pre[i])
		switch {
		case errX == nil && errY == nil:
			if x != y {
				return sign(x - y)
			}
		case errX == nil:
			return -1
		case errY == nil:
			return 1
		default:
			if c := strings.Compare(a.pre[i], b.pre[i]); c != 0 {
				return c
			}
		}
	}
	return sign(len(a.pre) - len(b.pre))
}

func sign(n int) int {
	switch {
	case n > 0:
		return 1
	case n < 0:
		return -1
	}
	return 0
}
