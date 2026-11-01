"""Per-connection token buckets and a cache-backed fixed-window counter (SPEC §3.8)."""

from __future__ import annotations

import time

from django.core.cache import cache


class TokenBucket:
    def __init__(self, rate_per_s: float, burst: int):
        self.rate = float(rate_per_s)
        self.capacity = float(burst)
        self.tokens = float(burst)
        self.updated = time.monotonic()

    def allow(self, cost: float = 1.0) -> bool:
        now = time.monotonic()
        self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
        self.updated = now
        if self.tokens >= cost:
            self.tokens -= cost
            return True
        return False

    def retry_after_ms(self) -> int:
        missing = max(0.0, 1.0 - self.tokens)
        return int(missing / self.rate * 1000) + 1 if self.rate > 0 else 60000


def parse_rate(spec: str) -> tuple[int, int]:
    """'5/minute' → (5, 60). Supports second/minute/hour/day."""
    count, _, period = spec.partition("/")
    seconds = {"second": 1, "minute": 60, "hour": 3600, "day": 86400}[period.strip() or "minute"]
    return int(count), seconds


def window_allow(key: str, spec: str) -> bool:
    """Fixed-window counter in the cache: True if under the limit (and increments)."""
    limit, seconds = parse_rate(spec)
    bucket = int(time.time() // seconds)
    cache_key = f"rl:{key}:{bucket}"
    try:
        value = cache.incr(cache_key)
    except ValueError:
        cache.add(cache_key, 1, seconds)
        value = cache.get(cache_key, 1)
    return value <= limit
