package history

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func openTemp(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestSchemaAndMeta(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "h.sqlite")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	v, err := s.SchemaVersion()
	if err != nil || v != schemaVersion {
		t.Fatalf("schema_version = %q, %v", v, err)
	}
	var mode string
	if err := s.db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Errorf("journal_mode = %q, %v", mode, err)
	}
	_ = s.Close()
	// Reopen is idempotent.
	s2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	_ = s2.Close()
}

func TestAppendListGetDelete(t *testing.T) {
	s := openTemp(t)
	ctx := context.Background()
	id, _ := NewUUID()
	if !IsValidUUID(id) {
		t.Fatalf("bad uuid %q", id)
	}
	created, err := s.EnsureConversation(ctx, id, "Hello", "llama3.2:3b")
	if err != nil || !created {
		t.Fatalf("EnsureConversation = %v, %v", created, err)
	}
	created, err = s.EnsureConversation(ctx, id, "Other", "x")
	if err != nil || created {
		t.Fatalf("second EnsureConversation = %v, %v", created, err)
	}
	m1, err := s.AppendMessage(ctx, id, NewMessage{Role: "user", Content: "Oi"})
	if err != nil || m1.Seq != 1 {
		t.Fatalf("append user: %+v, %v", m1, err)
	}
	model := "llama3.2:1b"
	think := "pensando"
	m2, err := s.AppendMessage(ctx, id, NewMessage{Role: "assistant", Content: "Olá", Thinking: &think, Model: &model,
		Stats: &Stats{EvalCount: 3, TotalDuration: 10}, Aborted: true})
	if err != nil || m2.Seq != 2 {
		t.Fatalf("append assistant: %+v, %v", m2, err)
	}
	if _, err := s.AppendMessage(ctx, "missing", NewMessage{Role: "user", Content: "x"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("append to missing conversation: %v", err)
	}
	if _, err := s.AppendMessage(ctx, id, NewMessage{Role: "tool", Content: "x"}); err == nil {
		t.Error("invalid role accepted")
	}

	conv, msgs, more, err := s.Get(ctx, id, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if conv.Title != "Hello" || conv.Model != "llama3.2:1b" || conv.MessageCount != 2 || more {
		t.Errorf("conversation = %+v more=%v", conv, more)
	}
	if len(msgs) != 2 || msgs[1].Thinking == nil || *msgs[1].Thinking != think || !msgs[1].Aborted || msgs[1].Stats == nil || msgs[1].Stats.EvalCount != 3 {
		t.Errorf("messages = %+v", msgs)
	}
	if msgs[0].Thinking != nil || msgs[0].Stats != nil || msgs[0].Aborted {
		t.Errorf("user message has extra fields: %+v", msgs[0])
	}
	// Paging by after_seq and limit.
	_, page, more, err := s.Get(ctx, id, 1, 1)
	if err != nil || len(page) != 1 || page[0].Seq != 2 || more {
		t.Errorf("page = %+v more=%v err=%v", page, more, err)
	}
	_, page, more, err = s.Get(ctx, id, 0, 1)
	if err != nil || len(page) != 1 || page[0].Seq != 1 || !more {
		t.Errorf("page = %+v more=%v err=%v", page, more, err)
	}
	if _, _, _, err := s.Get(ctx, "missing", 0, 0); !errors.Is(err, ErrNotFound) {
		t.Errorf("get missing: %v", err)
	}

	// Listing with cursor.
	id2, _ := NewUUID()
	time.Sleep(2 * time.Millisecond)
	if _, err := s.EnsureConversation(ctx, id2, "Second", "m"); err != nil {
		t.Fatal(err)
	}
	list, more, err := s.List(ctx, 1, "")
	if err != nil || len(list) != 1 || list[0].ID != id2 || !more {
		t.Fatalf("list = %+v more=%v err=%v", list, more, err)
	}
	list, more, err = s.List(ctx, 10, list[0].UpdatedAt)
	if err != nil || len(list) != 1 || list[0].ID != id || more {
		t.Fatalf("list page 2 = %+v more=%v err=%v", list, more, err)
	}
	if _, _, err := s.List(ctx, 10, "yesterday"); err == nil {
		t.Error("bad cursor accepted")
	}
	// A cursor with a different ISO rendering still works.
	cur, _ := time.Parse(timeLayout, list[0].UpdatedAt)
	list, _, err = s.List(ctx, 10, cur.Add(time.Millisecond).Format(time.RFC3339Nano))
	if err != nil || len(list) != 1 {
		t.Errorf("list with RFC3339Nano cursor = %+v, %v", list, err)
	}

	if err := s.Delete(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, id); !errors.Is(err, ErrNotFound) {
		t.Errorf("second delete: %v", err)
	}
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE conversation_id = ?`, id).Scan(&n); err != nil || n != 0 {
		t.Errorf("messages not cascaded: n=%d err=%v", n, err)
	}
}

func TestTitleFromContent(t *testing.T) {
	if got := TitleFromContent("  hello\n  world  "); got != "hello world" {
		t.Errorf("got %q", got)
	}
	long := strings.Repeat("é", 100)
	if got := TitleFromContent(long); len([]rune(got)) != TitleMaxRunes {
		t.Errorf("got %d runes", len([]rune(got)))
	}
	if got := TitleFromContent("   "); got != "Untitled" {
		t.Errorf("got %q", got)
	}
}

// Minimal byte strings that start with the accepted magic numbers.
var (
	tinyPNG = []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 'I', 'H', 'D', 'R'}
	tinyGIF = []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;")
)

// schemaV1 is the schema written by the previous release (no message_images, version 1).
const schemaV1 = `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('system','user','assistant')),
  content TEXT NOT NULL, thinking TEXT, model TEXT, stats_json TEXT,
  aborted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (conversation_id, seq));
CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta(key, value) VALUES ('schema_version', '1');
INSERT INTO conversations VALUES ('11111111-1111-4111-8111-111111111111', 'Old', 'llama3.2:1b', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', 2);
INSERT INTO messages(id, conversation_id, seq, role, content, created_at)
  VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 1, 'user', 'hi', '2026-01-01T00:00:00.000Z');
INSERT INTO messages(id, conversation_id, seq, role, content, model, created_at)
  VALUES ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 2, 'assistant', 'hello', 'llama3.2:1b', '2026-01-01T00:00:01.000Z');
`

func TestMigrateV1ToCurrent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(schemaV1); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open(v1 database) = %v", err)
	}
	if v, err := s.SchemaVersion(); err != nil || v != schemaVersion {
		t.Fatalf("schema_version after migration = %q, %v", v, err)
	}
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'message_images'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("message_images table: n=%d err=%v", n, err)
	}
	// Old rows are intact and readable; the new table is usable.
	ctx := context.Background()
	conv, msgs, more, err := s.Get(ctx, "11111111-1111-4111-8111-111111111111", 0, 0)
	if err != nil || conv.Title != "Old" || len(msgs) != 2 || more || msgs[0].Images != nil || msgs[1].Images != nil {
		t.Fatalf("old conversation = %+v / %+v more=%v err=%v", conv, msgs, more, err)
	}
	m, err := s.AppendMessage(ctx, conv.ID, NewMessage{Role: "user", Content: "look", Images: []Image{{Mime: "image/png", Data: tinyPNG}}})
	if err != nil || m.Seq != 3 || len(m.Images) != 1 {
		t.Fatalf("append after migration = %+v, %v", m, err)
	}
	// v3: the old conversation takes an agent; agents and skills are usable.
	agentID := "22222222-2222-4222-8222-222222222222"
	if err := s.SetConversationSetup(ctx, conv.ID, agentID, nil); err != nil {
		t.Fatalf("SetConversationSetup after migration = %v", err)
	}
	if c, _, _, err := s.Get(ctx, conv.ID, 0, 1); err != nil || c.AgentID != agentID {
		t.Fatalf("agent after migration = %+v, %v", c, err)
	}
	if _, err := s.SaveSkill(ctx, Skill{ID: agentID, Name: "x"}); err != nil {
		t.Fatalf("SaveSkill after migration = %v", err)
	}
	// v4: agents keep a chain; an assistant message keeps the answers of the earlier agents.
	if a, err := s.SaveAgent(ctx, Agent{ID: agentID, Name: "a", Model: "m", Skills: "off", Chain: []string{conv.ID}}); err != nil || len(a.Chain) != 1 {
		t.Fatalf("SaveAgent with a chain after migration = %+v, %v", a, err)
	}
	if _, err := s.AppendMessage(ctx, conv.ID, NewMessage{Role: "assistant", Content: "final", Chain: []ChainStep{{AgentID: agentID, Name: "a", Model: "m", Content: "first"}}}); err != nil {
		t.Fatalf("append a chained answer after migration = %v", err)
	}
	_ = s.Close()
	// Reopening is idempotent; a future version is refused.
	s2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := s2.SchemaVersion(); v != schemaVersion {
		t.Errorf("schema_version on reopen = %q", v)
	}
	if _, err := s2.db.Exec(`UPDATE meta SET value = '5' WHERE key = 'schema_version'`); err != nil {
		t.Fatal(err)
	}
	_ = s2.Close()
	if _, err := Open(path); err == nil || !strings.Contains(err.Error(), "unsupported schema version 5") {
		t.Errorf("Open(v5) = %v", err)
	}
}

func TestImagesRoundTripAndCascade(t *testing.T) {
	s := openTemp(t)
	ctx := context.Background()
	id, _ := NewUUID()
	if _, err := s.EnsureConversation(ctx, id, "Pics", "moondream"); err != nil {
		t.Fatal(err)
	}
	big := append(append([]byte{}, tinyGIF...), bytes.Repeat([]byte{0xAB, 0x00, 0xFF}, 1000)...)
	in := []Image{{Mime: "image/png", Data: tinyPNG}, {Mime: "image/gif", Data: big}}
	m, err := s.AppendMessage(ctx, id, NewMessage{Role: "user", Content: "", Images: in})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Images) != 2 || m.Images[0] != base64.StdEncoding.EncodeToString(tinyPNG) {
		t.Errorf("returned images = %v", m.Images)
	}
	if _, err := s.AppendMessage(ctx, id, NewMessage{Role: "assistant", Content: "x", Images: in[:1]}); !errors.Is(err, ErrImagesRole) {
		t.Errorf("assistant with images: %v", err)
	}
	if _, err := s.AppendMessage(ctx, id, NewMessage{Role: "user", Content: "x", Images: []Image{{Mime: "", Data: tinyPNG}}}); err == nil {
		t.Error("image without mime accepted")
	}
	if _, err := s.AppendMessage(ctx, id, NewMessage{Role: "assistant", Content: "a red square"}); err != nil {
		t.Fatal(err)
	}
	_, msgs, more, err := s.Get(ctx, id, 0, 0)
	if err != nil || len(msgs) != 2 || more {
		t.Fatalf("get = %+v more=%v err=%v", msgs, more, err)
	}
	if len(msgs[0].Images) != 2 || msgs[1].Images != nil {
		t.Fatalf("images = %v / %v", msgs[0].Images, msgs[1].Images)
	}
	for i, want := range in {
		got, err := base64.StdEncoding.DecodeString(msgs[0].Images[i])
		if err != nil || !bytes.Equal(got, want.Data) {
			t.Errorf("image %d does not round-trip (err=%v, %d bytes vs %d)", i, err, len(got), len(want.Data))
		}
	}
	var mime string
	if err := s.db.QueryRow(`SELECT mime FROM message_images WHERE message_id = ? AND idx = 1`, m.ID).Scan(&mime); err != nil || mime != "image/gif" {
		t.Errorf("mime stored = %q, %v", mime, err)
	}
	// Deleting the conversation cascades to messages and to their images.
	if err := s.Delete(ctx, id); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM message_images`).Scan(&n); err != nil || n != 0 {
		t.Errorf("images not cascaded: n=%d err=%v", n, err)
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&n); err != nil || n != 0 {
		t.Errorf("messages not cascaded: n=%d err=%v", n, err)
	}
}

func TestGetPageByteBudget(t *testing.T) {
	s := openTemp(t)
	ctx := context.Background()
	id, _ := NewUUID()
	if _, err := s.EnsureConversation(ctx, id, "Big", "moondream"); err != nil {
		t.Fatal(err)
	}
	// Four user messages with one ~2 MiB image each (~2.8 MiB of base64): two fit in 6 MiB,
	// three do not. Assistant replies in between are tiny.
	img := append(append([]byte{}, tinyPNG...), bytes.Repeat([]byte{0x5A}, 2<<20)...)
	for i := 0; i < 4; i++ {
		if _, err := s.AppendMessage(ctx, id, NewMessage{Role: "user", Content: "pic", Images: []Image{{Mime: "image/png", Data: img}}}); err != nil {
			t.Fatal(err)
		}
		if _, err := s.AppendMessage(ctx, id, NewMessage{Role: "assistant", Content: "ok"}); err != nil {
			t.Fatal(err)
		}
	}
	var pages [][]Message
	var after int64
	for {
		_, msgs, more, err := s.Get(ctx, id, after, 0)
		if err != nil {
			t.Fatal(err)
		}
		if len(msgs) == 0 {
			t.Fatalf("empty page after seq %d (more=%v)", after, more)
		}
		size := 0
		for _, m := range msgs {
			n, _ := jsonSize(m)
			size += n
		}
		if size > MaxPageBytes {
			t.Errorf("page after seq %d is %d bytes > %d", after, size, MaxPageBytes)
		}
		pages = append(pages, msgs)
		after = msgs[len(msgs)-1].Seq
		if !more {
			break
		}
	}
	if len(pages) != 2 || len(pages[0]) != 4 || len(pages[1]) != 4 {
		sizes := make([]int, len(pages))
		for i, p := range pages {
			sizes[i] = len(p)
		}
		t.Fatalf("pages = %v, want [4 4] (two images per page)", sizes)
	}
	if pages[0][3].Seq != 4 || pages[1][0].Seq != 5 || pages[1][3].Seq != 8 {
		t.Errorf("seq continuity broken: %d %d %d", pages[0][3].Seq, pages[1][0].Seq, pages[1][3].Seq)
	}
	// A single message larger than the budget is still returned (alone, with hasMore).
	huge := append(append([]byte{}, tinyPNG...), bytes.Repeat([]byte{0x5A}, 5<<20)...)
	if _, err := s.AppendMessage(ctx, id, NewMessage{Role: "user", Content: "huge", Images: []Image{{Mime: "image/png", Data: huge}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendMessage(ctx, id, NewMessage{Role: "assistant", Content: "ok"}); err != nil {
		t.Fatal(err)
	}
	_, msgs, more, err := s.Get(ctx, id, 8, 0)
	if err != nil || len(msgs) != 1 || msgs[0].Seq != 9 || !more {
		t.Fatalf("oversize single message page = %d msgs more=%v err=%v", len(msgs), more, err)
	}
	_, msgs, more, err = s.Get(ctx, id, 9, 0)
	if err != nil || len(msgs) != 1 || msgs[0].Seq != 10 || more {
		t.Fatalf("last page = %d msgs more=%v err=%v", len(msgs), more, err)
	}
}

func TestStatsAndClearShrinksFile(t *testing.T) {
	s := openTemp(t)
	ctx := context.Background()
	if n, size, err := s.Stats(ctx); err != nil || n != 0 || size <= 0 {
		t.Fatalf("empty stats = %d, %d, %v", n, size, err)
	}
	big := bytes.Repeat([]byte{0x89, 'P', 'N', 'G', 1, 2, 3, 4}, 64<<10) // 512 KiB per image
	for i := 0; i < 3; i++ {
		id, _ := NewUUID()
		if _, err := s.EnsureConversation(ctx, id, "c", "m"); err != nil {
			t.Fatal(err)
		}
		if _, err := s.AppendMessage(ctx, id, NewMessage{Role: "user", Content: "x", Images: []Image{{Mime: "image/png", Data: big}}}); err != nil {
			t.Fatal(err)
		}
	}
	n, before, err := s.Stats(ctx)
	if err != nil || n != 3 || before < 3*512<<10 {
		t.Fatalf("stats = %d conversations, %d bytes, %v", n, before, err)
	}
	if err := s.Clear(ctx); err != nil {
		t.Fatal(err)
	}
	n, after, err := s.Stats(ctx)
	if err != nil || n != 0 {
		t.Fatalf("after clear = %d, %v", n, err)
	}
	if after >= before/4 {
		t.Errorf("file did not shrink: %d → %d bytes", before, after)
	}
	var imgs, msgs int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM message_images`).Scan(&imgs)
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&msgs)
	if imgs != 0 || msgs != 0 {
		t.Errorf("leftovers: %d messages, %d images", msgs, imgs)
	}
	// Still usable afterwards.
	id, _ := NewUUID()
	if _, err := s.EnsureConversation(ctx, id, "again", "m"); err != nil {
		t.Fatal(err)
	}
}

func TestFilesReadableOnlyByThisAccount(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the user profile's ACL protects the file on Windows")
	}
	mode := func(p string) os.FileMode {
		t.Helper()
		st, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		return st.Mode().Perm()
	}
	dir := t.TempDir()

	// A new database, written once so that the -wal and -shm files exist.
	fresh := filepath.Join(dir, "new.sqlite")
	s, err := Open(fresh)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO meta(key, value) VALUES ('probe', '1')`); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{fresh, fresh + "-wal", fresh + "-shm"} {
		if got := mode(p); got != 0o600 {
			t.Errorf("%s: mode %o, want 600", filepath.Base(p), got)
		}
	}
	_ = s.Close()

	// A database left open to other accounts by an older version, with its -wal and -shm.
	old := filepath.Join(dir, "old.sqlite")
	raw, err := sql.Open("sqlite", old)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = raw.Close() }()
	if _, err := raw.Exec(`PRAGMA journal_mode=WAL`); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`CREATE TABLE t(x); INSERT INTO t VALUES (1)`); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{old, old + "-wal", old + "-shm"} {
		if err := os.Chmod(p, 0o644); err != nil { //nolint:gosec // deliberately open, as an older version left it
			t.Fatal(err)
		}
	}
	s2, err := Open(old)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s2.Close() }()
	for _, p := range []string{old, old + "-wal", old + "-shm"} {
		if got := mode(p); got != 0o600 {
			t.Errorf("old %s: mode %o, want 600", filepath.Base(p), got)
		}
	}
}
