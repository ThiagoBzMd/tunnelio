"""
Fetch and parse ollama.com/library (HTML; there is no JSON API). The page lists every model with
its description, capability tags (tools, vision, thinking, embedding, cloud), parameter sizes
(1b, 7b, 70b…), pull count, tag count and last update. The parser works per `<li>` with small
regular expressions and classifies tags by their text, not by CSS classes, so a restyle of the
page does not break it; an entry it cannot read is skipped, never guessed.

Each model's own page (ollama.com/library/<name>) lists its tags with their download size; those
pages give `size_bytes` (rev. 1.9), read only for models that are new or that the library updated.
"""

from __future__ import annotations

import html
import json
import re
import time
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

MAX_HTML_BYTES = 8 * 1024 * 1024
FETCH_TIMEOUT_S = 30
USER_AGENT = "Tunnelio-server (model catalog refresh)"
SNAPSHOT_PATH = Path(__file__).resolve().parent / "data" / "ollama-library.json"

CAPABILITIES = {"tools", "vision", "thinking", "embedding", "cloud"}
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
SIZE_RE = re.compile(r"^e?\d+(?:\.\d+)?[bmk]$|^\d+x\d+(?:\.\d+)?b$")  # 1b, 270m, e4b, 8x7b

PAGE_MAX_BYTES = 2 * 1024 * 1024
PAGE_TIMEOUT_S = 15
PAGE_DELAY_S = 1.0  # between two model pages: the whole library takes about four minutes
MAX_FAILURES_IN_A_ROW = 5  # the site is down: stop, the next run tries again

_ITEM_RE = re.compile(r"<li\b[^>]*>(.*?)</li>", re.S)
_HREF_RE = re.compile(r'href="/library/([^"/?#]+)"')
_DESC_RE = re.compile(r'<p class="max-w-lg[^"]*">(.*?)</p>', re.S)
_TAG_RE = re.compile(r'<span\s+class="inline-flex items-center rounded-md[^"]*">\s*([^<]*?)\s*</span>')
_STAT_RE = re.compile(r"<span\s*>([^<]+)</span>\s*<span\s+class=\"hidden sm:flex\">(?:&nbsp;|\s)*(Pulls|Tags)\b")
_UPDATED_TITLE_RE = re.compile(r'<span\s+class="flex items-center"\s+title="([^"]+)">')
_UPDATED_TEXT_RE = re.compile(r"Updated(?:&nbsp;|\s)*</span>\s*<span\s*>([^<]+)</span>")
_WS_RE = re.compile(r"\s+")
_BYTES_RE = re.compile(r"(\d+(?:\.\d+)?)\s?([KMGT]B)\b")
_UNITS = {"KB": 10**3, "MB": 10**6, "GB": 10**9, "TB": 10**12}  # decimal, as the library writes them


def _fetch(url: str, limit: int, timeout: float) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — configured URL
        data = resp.read(limit + 1)
    if len(data) > limit:
        raise ValueError("page larger than the limit")
    return data.decode("utf-8", errors="replace")


def fetch_library(url: str) -> str:
    """The page's HTML (UTF-8), at most MAX_HTML_BYTES."""
    return _fetch(url, MAX_HTML_BYTES, FETCH_TIMEOUT_S)


def model_page_url(library_url: str, name: str) -> str:
    """'https://ollama.com/library?sort=popular', 'llama3.2' → 'https://ollama.com/library/llama3.2'."""
    parts = urllib.parse.urlsplit(library_url)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, f"{parts.path.rstrip('/')}/{name}", "", ""))


def fetch_model_page(library_url: str, name: str) -> str:
    """A model's page, next to the configured list page; at most PAGE_MAX_BYTES."""
    return _fetch(model_page_url(library_url, name), PAGE_MAX_BYTES, PAGE_TIMEOUT_S)


def parse_count(text: str) -> int | None:
    """'120.3M' → 120300000, '93.5K' → 93500, '1,234' → 1234; None when unreadable."""
    t = text.strip().replace(",", "")
    m = re.fullmatch(r"(\d+(?:\.\d+)?)([KMB]?)", t, re.I)
    if not m:
        return None
    value = float(m.group(1))
    mult = {"": 1, "K": 1_000, "M": 1_000_000, "B": 1_000_000_000}[m.group(2).upper()]
    return int(round(value * mult))


def parse_updated(title: str) -> str | None:
    """'Nov 30, 2024 10:34 PM UTC' → ISO 8601 (UTC); None when the format changed."""
    try:
        return datetime.strptime(title.strip(), "%b %d, %Y %I:%M %p UTC").replace(tzinfo=UTC).isoformat()
    except ValueError:
        return None


def _clean(fragment: str) -> str:
    return html.unescape(_WS_RE.sub(" ", re.sub(r"<[^>]+>", "", fragment))).strip()


def parse_entry(item: str) -> dict[str, Any] | None:
    m = _HREF_RE.search(item)
    if not m:
        return None
    name = m.group(1)
    if not NAME_RE.match(name):
        return None
    desc = _DESC_RE.search(item)
    capabilities: list[str] = []
    sizes: list[str] = []
    for raw in _TAG_RE.findall(item):
        tag = _clean(raw).lower()
        if tag in CAPABILITIES:
            if tag not in capabilities:
                capabilities.append(tag)
        elif SIZE_RE.match(tag):
            if tag not in sizes:
                sizes.append(tag)
    stats = {kind: value for value, kind in _STAT_RE.findall(item)}
    pulls_text = _clean(stats.get("Pulls", ""))
    tags_text = _clean(stats.get("Tags", ""))
    title = _UPDATED_TITLE_RE.search(item)
    updated_text = _UPDATED_TEXT_RE.search(item)
    return {
        "name": name,
        "description": _clean(desc.group(1))[:300] if desc else "",
        "capabilities": capabilities,
        "sizes": sizes,
        "pulls": parse_count(pulls_text) if pulls_text else None,
        "pulls_text": pulls_text,
        "tags": parse_count(tags_text) if tags_text else None,
        "updated_at": parse_updated(title.group(1)) if title else None,
        "updated_text": _clean(updated_text.group(1)) if updated_text else "",
    }


def parse_library(page: str) -> list[dict[str, Any]]:
    """Every readable entry, in page order (the page is requested sorted by popularity)."""
    start = page.find('id="repo"')
    body = page[start:] if start >= 0 else page
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in _ITEM_RE.findall(body):
        entry = parse_entry(item)
        if entry and entry["name"] not in seen:
            seen.add(entry["name"])
            out.append(entry)
    return out


def parse_bytes(text: str) -> int | None:
    """'2.0GB' → 2000000000, '523MB' → 523000000; None when unreadable (the cloud tags read '-')."""
    m = _BYTES_RE.fullmatch(text.strip())
    return int(round(float(m.group(1)) * _UNITS[m.group(2)])) if m else None


def parse_model_sizes(page: str, name: str, tags: Iterable[str]) -> dict[str, list[int]]:
    """
    The download size of each wanted tag, from the model's page, where a tag's row reads
    "llama3.2:3b latest 2.0GB · 128K context window · Text · …", or a range ("6.6GB - 9.5GB") when
    the tag has a variant per platform: {"3b": [2000000000, 2000000000], "e4b": [6600000000,
    9500000000]}. A tag with no size or not on the page is left out.
    """
    wanted = set(tags)
    row_re = re.compile(r'<a\s[^>]*?href="/library/' + re.escape(name) + r':([^"/?#]+)"[^>]*>(.*?)</a>', re.S)
    out: dict[str, list[int]] = {}
    for tag, inner in row_re.findall(page):
        if tag not in wanted or tag in out:
            continue
        # The size comes before the first "·"; the name is dropped first, so no part of it can count.
        head = _clean(inner).split("·", 1)[0].replace(f"{name}:{tag}", " ")
        found = [n for n in (parse_bytes(v + u) for v, u in _BYTES_RE.findall(head)) if n]
        if found:
            out[tag] = [min(found), max(found)]
    return out


def wanted_tags(entry: dict[str, Any]) -> list[str]:
    """The tags one click pulls from an entry: each size, and "latest" (the one Ollama recommends)."""
    return [*entry["sizes"], "latest"]


def carry_sizes(models: list[dict[str, Any]], previous: Iterable[Any]) -> list[dict[str, Any]]:
    """
    Copies each entry's `size_bytes` from the previous list and returns the entries whose page must
    be read: new ones, and those the library updated (or whose sizes changed) since.
    """
    old = {m["name"]: m for m in previous if isinstance(m, dict) and isinstance(m.get("name"), str)}
    stale = []
    for entry in models:
        before = old.get(entry["name"])
        known = before.get("size_bytes") if before else None
        if isinstance(known, dict):
            entry["size_bytes"] = dict(known)
        if (
            not isinstance(known, dict)
            or entry["updated_at"] is None
            or before.get("updated_at") != entry["updated_at"]
            or before.get("sizes") != entry["sizes"]
        ):
            stale.append(entry)
    return stale


def read_sizes(
    entries: list[dict[str, Any]],
    fetch: Callable[[str], str],
    *,
    delay: float = PAGE_DELAY_S,
    on_progress: Callable[[], None] | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[int, int]:
    """
    Reads each entry's page (`fetch(name)` → HTML) and sets its `size_bytes`; returns (read,
    failed). A page that fails leaves the entry as it was; so does one where no size is found while
    sizes were known (a page that changed, not a model that lost them). MAX_FAILURES_IN_A_ROW
    failures in a row stop it. `on_progress` runs every 25 pages read, to store them as they come.
    """
    read = failed = in_a_row = 0
    for i, entry in enumerate(entries):
        if i:
            sleep(delay)
        try:
            page = fetch(entry["name"])
        except Exception:  # network, HTTP, size, a missing file: this one stays as it was
            failed += 1
            in_a_row += 1
            if in_a_row >= MAX_FAILURES_IN_A_ROW:
                break
            continue
        in_a_row = 0
        read += 1
        sizes = parse_model_sizes(page, entry["name"], wanted_tags(entry))
        if sizes or not entry.get("size_bytes"):
            entry["size_bytes"] = sizes
        if on_progress and read % 25 == 0:
            on_progress()
    return read, failed


@lru_cache(maxsize=1)
def load_snapshot() -> dict[str, Any]:
    """The bundled list (`data/ollama-library.json`), or an empty one when the file is missing."""
    try:
        return json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"source": "", "fetched_at": None, "models": []}


def write_snapshot(path: Path, source: str, fetched_at: datetime, models: list[dict[str, Any]]) -> None:
    """The bundled copy keeps the facts (names, sizes, counts, dates) but not the descriptions: those
    are ollama.com's own text, so they come only from a live fetch, never from this repository."""
    facts = [{k: v for k, v in m.items() if k != "description"} for m in models]
    payload = {"source": source, "fetched_at": fetched_at.isoformat(), "models": facts}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
