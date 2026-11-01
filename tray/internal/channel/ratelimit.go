package channel

import (
	"sync"
	"time"
)

// tokenBucket implements the per-session request limit (SPEC §7.6): rate tokens per minute,
// burst capacity.
type tokenBucket struct {
	mu       sync.Mutex
	tokens   float64
	capacity float64
	perSec   float64
	last     time.Time
	now      func() time.Time
}

func newTokenBucket(perMinute, burst int, now func() time.Time) *tokenBucket {
	return &tokenBucket{tokens: float64(burst), capacity: float64(burst), perSec: float64(perMinute) / 60, last: now(), now: now}
}

// take consumes one token. When empty it returns false and how long until one is available.
func (b *tokenBucket) take() (bool, time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * b.perSec
		if b.tokens > b.capacity {
			b.tokens = b.capacity
		}
		b.last = now
	}
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	wait := time.Duration((1 - b.tokens) / b.perSec * float64(time.Second))
	return false, wait
}
