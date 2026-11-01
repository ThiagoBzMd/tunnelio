"""The Ollama library parser (against saved pages), the refresh command and the REST view."""

from __future__ import annotations

from pathlib import Path

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import Client

from catalog.library import (
    MAX_FAILURES_IN_A_ROW,
    carry_sizes,
    load_snapshot,
    model_page_url,
    parse_bytes,
    parse_count,
    parse_library,
    parse_model_sizes,
    parse_updated,
    read_sizes,
)
from catalog.models import OllamaCatalog

User = get_user_model()
SAMPLE = Path(__file__).resolve().parent / "testdata" / "library-sample.html"
PAGES = Path(__file__).resolve().parent / "testdata" / "pages"  # trimmed model pages (the tags section)
GB = 1_000_000_000


def test_parse_counts_and_dates():
    assert parse_count("120.3M") == 120_300_000
    assert parse_count("93.5K") == 93_500
    assert parse_count("1,234") == 1234
    assert parse_count("93") == 93
    assert parse_count("many") is None
    assert parse_updated("Nov 30, 2024 10:34 PM UTC") == "2024-11-30T22:34:00+00:00"
    assert parse_updated("yesterday") is None


def test_parse_library_sample():
    models = parse_library(SAMPLE.read_text(encoding="utf-8"))
    assert [m["name"] for m in models] == ["llama3.1", "deepseek-r1", "nomic-embed-text"]
    llama = models[0]
    assert llama["description"] == "Test description of a text model in three sizes, with tools."
    assert llama["capabilities"] == ["tools"]
    assert llama["sizes"] == ["8b", "70b", "405b"]
    assert llama["pulls"] and llama["pulls"] > 100_000_000
    assert llama["pulls_text"].endswith("M")
    assert llama["tags"] == 93
    assert llama["updated_at"] == "2024-11-30T22:34:00+00:00"
    assert llama["updated_text"].endswith("ago")
    deepseek = models[1]
    assert "thinking" in deepseek["capabilities"]
    assert "7b" in deepseek["sizes"]
    embed = models[2]
    assert embed["capabilities"] == ["embedding"]


def test_parse_library_skips_unreadable_items():
    page = (
        '<div id="repo"><ul><li><a href="/library/Bad Name">x</a></li><li>no link</li>'
        '<li><a href="/library/ok-model"></a></li></ul></div>'
    )
    models = parse_library(page)
    assert [m["name"] for m in models] == ["ok-model"]
    assert models[0]["sizes"] == [] and models[0]["pulls"] is None


def test_parse_library_reads_effective_sizes():
    item = (
        '<div id="repo"><ul><li><a href="/library/gemma3n"><span class="inline-flex items-center rounded-md x">'
        'e2b</span><span class="inline-flex items-center rounded-md x">e4b</span></a></li></ul></div>'
    )
    assert parse_library(item)[0]["sizes"] == ["e2b", "e4b"]


def test_parse_model_sizes():
    assert parse_bytes("2.0GB") == 2 * GB and parse_bytes("523MB") == 523_000_000 and parse_bytes("-") is None
    assert model_page_url("https://ollama.com/library?sort=popular", "llama3.2") == "https://ollama.com/library/llama3.2"
    llama = parse_model_sizes((PAGES / "llama3.1.html").read_text(encoding="utf-8"), "llama3.1", ["8b", "70b", "405b", "latest"])
    assert llama == {"latest": [4_900_000_000] * 2, "8b": [4_900_000_000] * 2, "70b": [43 * GB] * 2, "405b": [243 * GB] * 2}
    embed = parse_model_sizes((PAGES / "nomic-embed-text.html").read_text(encoding="utf-8"), "nomic-embed-text", ["latest"])
    assert embed == {"latest": [274_000_000] * 2}
    # A tag with a variant per platform reads as a range; the cloud and MLX tags are not wanted.
    gemma = parse_model_sizes(
        (PAGES / "gemma4.html").read_text(encoding="utf-8"), "gemma4", ["e2b", "e4b", "12b", "26b", "31b", "latest"]
    )
    assert gemma["e4b"] == [6_600_000_000, 9_500_000_000] and gemma["latest"] == gemma["e4b"]
    assert gemma["31b"] == [19 * GB, 20 * GB] and set(gemma) == {"e2b", "e4b", "12b", "26b", "31b", "latest"}
    # The name never counts as a size, a cloud tag has none.
    row = '<a href="/library/m:70b"><p>m:70b</p><p>- · 128K context window</p></a>'
    assert parse_model_sizes(row, "m", ["70b"]) == {}


def _entry(name, updated_at="2026-10-01T00:00:00+00:00", sizes=("1b",)):
    return {"name": name, "sizes": list(sizes), "updated_at": updated_at}


def test_carry_sizes_reads_only_new_or_updated_models():
    previous = [
        {**_entry("same"), "size_bytes": {"1b": [GB, GB]}},
        {**_entry("updated"), "size_bytes": {"1b": [GB, GB]}},
        {**_entry("resized"), "size_bytes": {"1b": [GB, GB]}},
        _entry("never-read"),
        "junk",
    ]
    models = [
        _entry("same"),
        _entry("updated", updated_at="2026-10-15T00:00:00+00:00"),
        _entry("resized", sizes=("1b", "3b")),
        _entry("never-read"),
        _entry("new"),
    ]
    stale = carry_sizes(models, previous)
    assert [m["name"] for m in stale] == ["updated", "resized", "never-read", "new"]
    assert models[0]["size_bytes"] == {"1b": [GB, GB]} and models[1]["size_bytes"] == {"1b": [GB, GB]}
    assert "size_bytes" not in models[3] and "size_bytes" not in models[4]


def test_read_sizes_keeps_what_it_cannot_read():
    page = '<a href="/library/{n}:1b"><p>{n}:1b</p><p>1.3GB · 128K context window</p></a>'
    entries = [
        {**_entry("ok"), "size_bytes": {"1b": [GB, GB]}},
        {**_entry("down"), "size_bytes": {"1b": [GB, GB]}},
        {**_entry("blank"), "size_bytes": {"1b": [GB, GB]}},
        _entry("cloud"),
    ]

    def fetch(name):
        if name == "down":
            raise OSError("timeout")
        return page.format(n=name) if name == "ok" else "<p>nothing here</p>"

    waits = []
    assert read_sizes(entries, fetch, sleep=waits.append) == (3, 1)
    assert entries[0]["size_bytes"] == {"1b": [1_300_000_000] * 2}
    assert entries[1]["size_bytes"] == {"1b": [GB, GB]}  # the page failed
    assert entries[2]["size_bytes"] == {"1b": [GB, GB]}  # nothing found where sizes were known
    assert entries[3]["size_bytes"] == {}  # read, and none to find: not read again until it changes
    assert waits == [1.0, 1.0, 1.0]

    calls = []

    def site_down(name):
        calls.append(name)
        raise OSError("down")

    down = [_entry(f"m{i}") for i in range(MAX_FAILURES_IN_A_ROW + 3)]
    assert read_sizes(down, site_down, delay=0, sleep=lambda _s: None) == (0, MAX_FAILURES_IN_A_ROW)
    assert len(calls) == MAX_FAILURES_IN_A_ROW  # it stopped: the rest wait for the next run


def test_snapshot_is_bundled():
    snap = load_snapshot()
    assert len(snap["models"]) >= 50
    assert snap["models"][0]["name"]
    assert sum(1 for m in snap["models"] if m.get("size_bytes")) >= 50  # regenerated with the sizes


@pytest.mark.django_db
def test_command_from_file_stores_and_rejects_short_pages(tmp_path):
    with pytest.raises(CommandError):
        call_command("refresh_ollama_catalog", from_file=str(SAMPLE))  # 3 < the default minimum of 50
    assert not OllamaCatalog.objects.exists()
    out = tmp_path / "snap.json"
    call_command("refresh_ollama_catalog", from_file=str(SAMPLE), min_models=1, snapshot=str(out))
    row = OllamaCatalog.objects.get(key="ollama")
    assert row.count == 3 and row.data[1]["name"] == "deepseek-r1"
    assert '"deepseek-r1"' in out.read_text(encoding="utf-8")


@pytest.mark.django_db
def test_command_reads_the_sizes_and_carries_them_over(tmp_path, monkeypatch):
    # Before the first fetch the bundled copy is the previous list; an empty one here.
    monkeypatch.setattr("catalog.management.commands.refresh_ollama_catalog.load_snapshot", lambda: {"models": []})
    call_command("refresh_ollama_catalog", from_file=str(SAMPLE), min_models=1, pages_from=str(PAGES))
    data = {m["name"]: m for m in OllamaCatalog.objects.get(key="ollama").data}
    assert data["llama3.1"]["size_bytes"]["8b"] == [4_900_000_000] * 2
    assert data["nomic-embed-text"]["size_bytes"] == {"latest": [274_000_000] * 2}
    assert "size_bytes" not in data["deepseek-r1"]  # no page for it: read again next time
    # Unchanged models keep their sizes without their page (here: none left to read them from).
    call_command("refresh_ollama_catalog", from_file=str(SAMPLE), min_models=1, pages_from=str(tmp_path))
    data = {m["name"]: m for m in OllamaCatalog.objects.get(key="ollama").data}
    assert data["llama3.1"]["size_bytes"]["405b"] == [243 * GB] * 2


@pytest.mark.django_db
def test_view_requires_login_and_falls_back_to_the_snapshot():
    assert Client().get("/api/catalog/ollama").status_code == 403
    c = Client()
    c.force_login(User.objects.create_user("a@example.com", "correct horse battery staple"))
    res = c.get("/api/catalog/ollama")
    assert res.status_code == 200
    body = res.json()
    assert body["origin"] == "snapshot" and len(body["models"]) >= 50
    assert res["Cache-Control"] == "private, max-age=3600"
    call_command("refresh_ollama_catalog", from_file=str(SAMPLE), min_models=1)
    body = c.get("/api/catalog/ollama").json()
    assert body["origin"] == "live" and [m["name"] for m in body["models"]] == ["llama3.1", "deepseek-r1", "nomic-embed-text"]
    assert body["fetched_at"]
