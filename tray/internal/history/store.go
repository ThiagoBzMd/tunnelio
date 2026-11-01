package history

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite" // database/sql driver "sqlite"
)

const (
	// schemaVersion is meta.schema_version of a database written by this build.
	//   1  conversations, messages, meta
	//   2  + message_images (idempotent migration: the table is only added)
	//   3  + agents, skills; conversations.agent_id / skill_ids (columns added in place)
	//   4  + agents.chain, messages.chain_json: agent chains (columns added in place)
	schemaVersion = "4"
	// timeLayout is the ISO 8601 UTC form stored in the database (lexically sortable).
	timeLayout = "2006-01-02T15:04:05.000Z"
	// DefaultListLimit / MaxListLimit bound history_list (SPEC §7.3).
	DefaultListLimit = 50
	MaxListLimit     = 100
	// DefaultGetLimit / MaxGetLimit bound history_get.
	DefaultGetLimit = 200
	MaxGetLimit     = 200
	// MaxPageBytes bounds the plaintext of one history_get response: Get stops adding
	// messages before the JSON of the page would exceed it and reports hasMore instead.
	MaxPageBytes = 6 << 20
	// pageReserve is what the response head (type, id, conversation head, has_more) may take.
	pageReserve = 16 << 10
	// TitleMaxRunes is the length of an auto-generated title (SPEC §9.2).
	TitleMaxRunes = 60
)

// ErrNotFound is returned when a conversation, agent or skill does not exist.
var ErrNotFound = errors.New("history: not found")

// ErrImagesRole is returned when a non-user message carries images.
var ErrImagesRole = errors.New("history: images only allowed on user messages")

const schema = `
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  model         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  agent_id      TEXT,
  skill_ids     TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('system','user','assistant')),
  content         TEXT NOT NULL,
  thinking        TEXT,
  model           TEXT,
  stats_json      TEXT,
  aborted         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  chain_json      TEXT,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS message_images (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  mime       TEXT NOT NULL,
  data       BLOB NOT NULL,
  PRIMARY KEY (message_id, idx)
);
CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  icon         TEXT NOT NULL,
  model        TEXT NOT NULL,
  instructions TEXT NOT NULL,
  options_json TEXT,
  think        INTEGER,
  skills_mode  TEXT NOT NULL CHECK (skills_mode IN ('off','all','selected')),
  skill_ids    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  chain        TEXT
);
CREATE TABLE IF NOT EXISTS skills (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  category     TEXT NOT NULL,
  instructions TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
`

// Image is one picture attached to a user message (raw bytes; mime by magic bytes).
type Image struct {
	Mime string
	Data []byte
}

// Conversation is one row of the conversations table. AgentID / SkillIDs (v3) are what the
// browser applied on the last turn, so reopening the conversation applies them again.
type Conversation struct {
	ID           string   `json:"id"`
	Title        string   `json:"title"`
	Model        string   `json:"model"`
	CreatedAt    string   `json:"created_at"`
	UpdatedAt    string   `json:"updated_at"`
	MessageCount int64    `json:"message_count"`
	AgentID      string   `json:"agent_id,omitempty"`
	SkillIDs     []string `json:"skill_ids,omitempty"`
}

// Stats mirrors chat_done.stats (SPEC §7.4) as stored in stats_json.
type Stats struct {
	TotalDuration      int64 `json:"total_duration"`
	LoadDuration       int64 `json:"load_duration"`
	PromptEvalCount    int64 `json:"prompt_eval_count"`
	PromptEvalDuration int64 `json:"prompt_eval_duration"`
	EvalCount          int64 `json:"eval_count"`
	EvalDuration       int64 `json:"eval_duration"`
}

// Message is one row of the messages table as returned to the browser. Images are the
// attached pictures in standard (padded) base64, in their original order — the same encoding
// the browser used in chat.messages[i].images. Chain (v4) is, on an assistant message answered
// by an agent chain, what the agents before the last one answered.
type Message struct {
	ID        string      `json:"id"`
	Seq       int64       `json:"seq"`
	Role      string      `json:"role"`
	Content   string      `json:"content"`
	Thinking  *string     `json:"thinking,omitempty"`
	CreatedAt string      `json:"created_at"`
	Model     *string     `json:"model,omitempty"`
	Stats     *Stats      `json:"stats,omitempty"`
	Aborted   bool        `json:"aborted,omitempty"`
	Images    []string    `json:"images,omitempty"`
	Chain     []ChainStep `json:"chain,omitempty"`
}

// ChainStep is one earlier agent of a chain and its answer (SPEC §9.4).
type ChainStep struct {
	AgentID string `json:"agent_id"`
	Name    string `json:"name"`
	Model   string `json:"model"`
	Content string `json:"content"`
}

// NewMessage is the input of AppendMessage. Images are accepted only with Role "user"; Chain only
// with Role "assistant".
type NewMessage struct {
	Role     string
	Content  string
	Thinking *string
	Model    *string
	Stats    *Stats
	Aborted  bool
	Images   []Image
	Chain    []ChainStep
}

// Store is the SQLite-backed private history.
type Store struct {
	db *sql.DB
}

// Open opens (or creates) the database at path, enables WAL and applies the schema. The file
// is readable only by this account (see keepPrivate).
func Open(path string) (*Store, error) {
	keepPrivate(path)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// One connection: PRAGMAs are per connection and SQLite serializes writers anyway.
	db.SetMaxOpenConns(1)
	for _, p := range []string{"PRAGMA journal_mode=WAL", "PRAGMA foreign_keys=ON", "PRAGMA busy_timeout=5000", "PRAGMA synchronous=NORMAL"} {
		if _, err := db.Exec(p); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("history: %s: %w", p, err)
		}
	}
	// Every statement is CREATE ... IF NOT EXISTS, so applying the full schema is also the
	// in-place migration of an older database for the new tables (v2 message_images, v3 agents
	// and skills); the columns added later (v3, v4) are added below when missing.
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("history: schema: %w", err)
	}
	for _, col := range [][2]string{{"conversations", "agent_id"}, {"conversations", "skill_ids"}, {"agents", "chain"}, {"messages", "chain_json"}} {
		if err := addColumnIfMissing(db, col[0], col[1], "TEXT"); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("history: migrate %s.%s: %w", col[0], col[1], err)
		}
	}
	var v string
	err = db.QueryRow(`SELECT value FROM meta WHERE key = 'schema_version'`).Scan(&v)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if _, err := db.Exec(`INSERT INTO meta(key, value) VALUES ('schema_version', ?)`, schemaVersion); err != nil {
			_ = db.Close()
			return nil, err
		}
	case err != nil:
		_ = db.Close()
		return nil, err
	case v == "1" || v == "2" || v == "3":
		if _, err := db.Exec(`UPDATE meta SET value = ? WHERE key = 'schema_version'`, schemaVersion); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("history: migrate schema %s -> %s: %w", v, schemaVersion, err)
		}
	case v != schemaVersion:
		_ = db.Close()
		return nil, fmt.Errorf("history: unsupported schema version %s (want %s)", v, schemaVersion)
	}
	return &Store{db: db}, nil
}

// addColumnIfMissing adds table.column (an older database) unless it is already there.
func addColumnIfMissing(db *sql.DB, table, column, decl string) error {
	rows, err := db.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return err
	}
	found := false
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			_ = rows.Close()
			return err
		}
		if name == column {
			found = true
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if found {
		return nil
	}
	// Identifiers come from the constants above, never from input.
	_, err = db.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + column + ` ` + decl)
	return err
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// SchemaVersion returns meta.schema_version.
func (s *Store) SchemaVersion() (string, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key = 'schema_version'`).Scan(&v)
	return v, err
}

// EnsureConversation creates the conversation if it does not exist. Returns true when created.
func (s *Store) EnsureConversation(ctx context.Context, id, title, model string) (bool, error) {
	now := nowString()
	res, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO conversations(id, title, model, created_at, updated_at, message_count)
		VALUES (?, ?, ?, ?, ?, 0)`, id, title, model, now, now)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// AppendMessage inserts the next message (seq = last + 1) with its images, bumps message_count
// and updated_at and, when the message carries a model, updates the conversation model.
// Append-only (SPEC §9.2).
func (s *Store) AppendMessage(ctx context.Context, conversationID string, m NewMessage) (*Message, error) {
	if len(m.Images) > 0 && m.Role != "user" {
		return nil, ErrImagesRole
	}
	if len(m.Chain) > 0 && m.Role != "assistant" {
		return nil, errors.New("history: a chain only goes with an assistant message")
	}
	for _, img := range m.Images {
		if img.Mime == "" || len(img.Data) == 0 {
			return nil, errors.New("history: image without mime or data")
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM conversations WHERE id = ?`, conversationID).Scan(&exists); err != nil {
		return nil, err
	}
	if exists == 0 {
		return nil, ErrNotFound
	}
	var seq int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?`, conversationID).Scan(&seq); err != nil {
		return nil, err
	}
	id, err := newUUID()
	if err != nil {
		return nil, err
	}
	now := nowString()
	var statsJSON *string
	if m.Stats != nil {
		b, err := json.Marshal(m.Stats)
		if err != nil {
			return nil, err
		}
		str := string(b)
		statsJSON = &str
	}
	aborted := 0
	if m.Aborted {
		aborted = 1
	}
	var chainJSON *string
	if len(m.Chain) > 0 {
		b, err := json.Marshal(m.Chain)
		if err != nil {
			return nil, err
		}
		str := string(b)
		chainJSON = &str
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO messages(id, conversation_id, seq, role, content, thinking, model, stats_json, aborted, created_at, chain_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, conversationID, seq, m.Role, m.Content, m.Thinking, m.Model, statsJSON, aborted, now, chainJSON); err != nil {
		return nil, err
	}
	var images []string
	for i, img := range m.Images {
		if _, err := tx.ExecContext(ctx, `INSERT INTO message_images(message_id, idx, mime, data) VALUES (?, ?, ?, ?)`,
			id, i, img.Mime, img.Data); err != nil {
			return nil, err
		}
		images = append(images, base64.StdEncoding.EncodeToString(img.Data))
	}
	if m.Model != nil && *m.Model != "" {
		_, err = tx.ExecContext(ctx, `UPDATE conversations SET message_count = message_count + 1, updated_at = ?, model = ? WHERE id = ?`, now, *m.Model, conversationID)
	} else {
		_, err = tx.ExecContext(ctx, `UPDATE conversations SET message_count = message_count + 1, updated_at = ? WHERE id = ?`, now, conversationID)
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &Message{ID: id, Seq: seq, Role: m.Role, Content: m.Content, Thinking: m.Thinking, CreatedAt: now, Model: m.Model, Stats: m.Stats, Aborted: m.Aborted, Images: images, Chain: m.Chain}, nil
}

const conversationColumns = `id, title, model, created_at, updated_at, message_count, agent_id, skill_ids`

type scanner interface{ Scan(dest ...any) error }

func scanConversation(row scanner) (*Conversation, error) {
	var c Conversation
	var agentID, skillIDs *string
	if err := row.Scan(&c.ID, &c.Title, &c.Model, &c.CreatedAt, &c.UpdatedAt, &c.MessageCount, &agentID, &skillIDs); err != nil {
		return nil, err
	}
	if agentID != nil {
		c.AgentID = *agentID
	}
	if skillIDs != nil && *skillIDs != "" {
		_ = json.Unmarshal([]byte(*skillIDs), &c.SkillIDs) // written by SetConversationSetup only
	}
	return &c, nil
}

// SetConversationSetup records the agent and the skills the browser applied on this turn
// (empty agentID / no skills = none). ErrNotFound when the conversation does not exist.
func (s *Store) SetConversationSetup(ctx context.Context, id, agentID string, skillIDs []string) error {
	var agent, skills any
	if agentID != "" {
		agent = agentID
	}
	if len(skillIDs) > 0 {
		b, err := json.Marshal(skillIDs)
		if err != nil {
			return err
		}
		skills = string(b)
	}
	res, err := s.db.ExecContext(ctx, `UPDATE conversations SET agent_id = ?, skill_ids = ? WHERE id = ?`, agent, skills, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// List returns conversations ordered by updated_at DESC, those strictly older than `before`
// (ISO 8601, optional). hasMore tells whether another page exists.
func (s *Store) List(ctx context.Context, limit int, before string) ([]Conversation, bool, error) {
	if limit <= 0 {
		limit = DefaultListLimit
	}
	if limit > MaxListLimit {
		limit = MaxListLimit
	}
	cursor, err := normalizeTime(before)
	if err != nil {
		return nil, false, err
	}
	var rows *sql.Rows
	if cursor == "" {
		rows, err = s.db.QueryContext(ctx, `SELECT `+conversationColumns+` FROM conversations
			ORDER BY updated_at DESC, id DESC LIMIT ?`, limit+1)
	} else {
		rows, err = s.db.QueryContext(ctx, `SELECT `+conversationColumns+` FROM conversations
			WHERE updated_at < ? ORDER BY updated_at DESC, id DESC LIMIT ?`, cursor, limit+1)
	}
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = rows.Close() }()
	out := []Conversation{}
	for rows.Next() {
		c, err := scanConversation(rows)
		if err != nil {
			return nil, false, err
		}
		out = append(out, *c)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	hasMore := len(out) > limit
	if hasMore {
		out = out[:limit]
	}
	return out, hasMore, nil
}

// Get returns the conversation and its messages with seq > afterSeq, ascending, up to limit
// rows and up to MaxPageBytes of JSON (images included): the page ends before the message
// that would exceed the budget and hasMore is set, so the caller continues from the last seq.
// The first message of a page is always returned, even when it alone exceeds the budget,
// otherwise paging could never pass it.
func (s *Store) Get(ctx context.Context, id string, afterSeq int64, limit int) (*Conversation, []Message, bool, error) {
	if limit <= 0 {
		limit = DefaultGetLimit
	}
	if limit > MaxGetLimit {
		limit = MaxGetLimit
	}
	c, err := scanConversation(s.db.QueryRowContext(ctx, `SELECT `+conversationColumns+` FROM conversations WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, false, ErrNotFound
	}
	if err != nil {
		return nil, nil, false, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, seq, role, content, thinking, model, stats_json, aborted, created_at, chain_json FROM messages
		WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`, id, afterSeq, limit+1)
	if err != nil {
		return nil, nil, false, err
	}
	defer func() { _ = rows.Close() }()
	msgs := []Message{}
	for rows.Next() {
		var m Message
		var statsJSON, chainJSON *string
		var aborted int
		if err := rows.Scan(&m.ID, &m.Seq, &m.Role, &m.Content, &m.Thinking, &m.Model, &statsJSON, &aborted, &m.CreatedAt, &chainJSON); err != nil {
			return nil, nil, false, err
		}
		if statsJSON != nil {
			var st Stats
			if json.Unmarshal([]byte(*statsJSON), &st) == nil {
				m.Stats = &st
			}
		}
		if chainJSON != nil && *chainJSON != "" {
			_ = json.Unmarshal([]byte(*chainJSON), &m.Chain) // written by AppendMessage only
		}
		m.Aborted = aborted != 0
		msgs = append(msgs, m)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, false, err
	}
	_ = rows.Close() // the single connection is needed for the image queries below
	hasMore := len(msgs) > limit
	if hasMore {
		msgs = msgs[:limit]
	}
	// Byte budget: images are loaded message by message, in order, and the page is cut before
	// the message that would push the JSON over MaxPageBytes.
	budget := MaxPageBytes - pageReserve
	used := 0
	for i := range msgs {
		if msgs[i].Role == "user" {
			images, err := s.loadImages(ctx, msgs[i].ID)
			if err != nil {
				return nil, nil, false, err
			}
			msgs[i].Images = images
		}
		size, err := jsonSize(msgs[i])
		if err != nil {
			return nil, nil, false, err
		}
		if i > 0 && used+size > budget {
			msgs = msgs[:i]
			hasMore = true
			break
		}
		used += size
	}
	return c, msgs, hasMore, nil
}

// loadImages returns the base64 images of one message in idx order (nil when none).
func (s *Store) loadImages(ctx context.Context, messageID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT data FROM message_images WHERE message_id = ? ORDER BY idx ASC`, messageID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		out = append(out, base64.StdEncoding.EncodeToString(data))
	}
	return out, rows.Err()
}

// jsonSize is the exact size of one message as the channel will serialize it (plus the comma).
func jsonSize(m Message) (int, error) {
	b, err := json.Marshal(m)
	if err != nil {
		return 0, err
	}
	return len(b) + 1, nil
}

// Delete removes a conversation and (by cascade) its messages. Returns ErrNotFound if absent.
func (s *Store) Delete(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM conversations WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// Stats returns how many conversations exist and how many bytes the database occupies on disk
// (page_count × page_size: free pages included, because that is what the file takes).
func (s *Store) Stats(ctx context.Context) (conversations int64, bytes int64, err error) {
	if err = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM conversations`).Scan(&conversations); err != nil {
		return 0, 0, err
	}
	var pages, size int64
	if err = s.db.QueryRowContext(ctx, `PRAGMA page_count`).Scan(&pages); err != nil {
		return 0, 0, err
	}
	if err = s.db.QueryRowContext(ctx, `PRAGMA page_size`).Scan(&size); err != nil {
		return 0, 0, err
	}
	return conversations, pages * size, nil
}

// Clear deletes every conversation (messages and images cascade) and gives the space back to
// the disk: VACUUM rewrites the file and the WAL is checkpointed and truncated.
func (s *Store) Clear(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM conversations`); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `VACUUM`); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`)
	return err
}

// TitleFromContent builds the default title: the first TitleMaxRunes runes of the text, trimmed.
func TitleFromContent(content string) string {
	t := strings.TrimSpace(strings.Join(strings.Fields(content), " "))
	if utf8.RuneCountInString(t) > TitleMaxRunes {
		r := []rune(t)
		t = strings.TrimSpace(string(r[:TitleMaxRunes]))
	}
	if t == "" {
		t = "Untitled"
	}
	return t
}

// IsValidUUID reports whether s is a canonical 8-4-4-4-12 hex UUID (any version, any case).
func IsValidUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
				return false
			}
		}
	}
	return true
}

func nowString() string { return time.Now().UTC().Format(timeLayout) }

// normalizeTime parses an ISO 8601 timestamp and re-renders it in timeLayout ("" stays "").
func normalizeTime(s string) (string, error) {
	if s == "" {
		return "", nil
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return "", fmt.Errorf("history: bad timestamp: %w", err)
	}
	return t.UTC().Format(timeLayout), nil
}

// newUUID returns a random (v4) UUID in canonical lower-case form.
func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32], nil
}

// NewUUID is exported for callers that need ids in the same format (tests, channel).
func NewUUID() (string, error) { return newUUID() }

// keepPrivate makes the conversations file readable only by this account (0600): the history is
// not encrypted on disk and relies on the system account (SPEC §9). SQLite would create the file
// as 0644; it creates the -wal and -shm files with the database's mode, so a new database is
// created empty with 0600 first. A file made by an older version (0644, with its -wal and -shm)
// is closed. Best effort, with no new way to fail: on Windows the profile's ACL already keeps
// other accounts out and Chmod cannot express it, and any error is left to sql.Open.
func keepPrivate(path string) {
	if runtime.GOOS == "windows" {
		return
	}
	if _, err := os.Stat(path); errors.Is(err, fs.ErrNotExist) {
		if f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600); err == nil { // #nosec G304 -- the tray's own history file
			_ = f.Close()
		}
	}
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		if st, err := os.Stat(p); err == nil && st.Mode().Perm()&0o077 != 0 {
			_ = os.Chmod(p, 0o600)
		}
	}
}
