package history

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// Agents and skills (schema v3, SPEC §9.4): kept in the same file as the conversations, on this
// computer only. The channel validates every field before it reaches the store; the store only
// enforces how many there may be and keeps created_at across saves.

const (
	// MaxAgents / MaxSkills bound what one computer keeps (a list stays a few MiB at most).
	MaxAgents = 100
	MaxSkills = 100
)

// ErrLimit is returned when saving a new agent or skill would exceed MaxAgents / MaxSkills.
var ErrLimit = errors.New("history: too many items")

// Agent is one saved agent. Options is the validated, re-encoded `options` object (SPEC §8.3)
// or nil; Think nil = the model's default. Skills is "off", "all" or "selected" (SkillIDs).
// Chain (v4) is the agents that answer after this one, in order (SPEC §9.4).
type Agent struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	Icon         string          `json:"icon"`
	Model        string          `json:"model"`
	Instructions string          `json:"instructions"`
	Options      json.RawMessage `json:"options,omitempty"`
	Think        *bool           `json:"think,omitempty"`
	Skills       string          `json:"skills"`
	SkillIDs     []string        `json:"skill_ids"`
	Chain        []string        `json:"chain"`
	CreatedAt    string          `json:"created_at"`
	UpdatedAt    string          `json:"updated_at"`
}

// Skill is one saved skill: reusable instructions (markdown) with a description of when they apply.
type Skill struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	Category     string `json:"category"`
	Instructions string `json:"instructions"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
}

// ListAgents returns every agent, by name.
func (s *Store) ListAgents(ctx context.Context) ([]Agent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, description, icon, model, instructions, options_json, think,
		skills_mode, skill_ids, created_at, updated_at, chain FROM agents ORDER BY name COLLATE NOCASE, id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Agent{}
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

func scanAgent(row scanner) (*Agent, error) {
	var a Agent
	var options *string
	var think *int64
	var skillIDs string
	var chain *string
	if err := row.Scan(&a.ID, &a.Name, &a.Description, &a.Icon, &a.Model, &a.Instructions, &options, &think,
		&a.Skills, &skillIDs, &a.CreatedAt, &a.UpdatedAt, &chain); err != nil {
		return nil, err
	}
	if options != nil && *options != "" {
		a.Options = json.RawMessage(*options)
	}
	if think != nil {
		v := *think != 0
		a.Think = &v
	}
	a.SkillIDs = []string{}
	if skillIDs != "" {
		_ = json.Unmarshal([]byte(skillIDs), &a.SkillIDs) // written by SaveAgent only
	}
	a.Chain = []string{}
	if chain != nil && *chain != "" {
		_ = json.Unmarshal([]byte(*chain), &a.Chain) // written by SaveAgent only
	}
	return &a, nil
}

// SaveAgent creates the agent or replaces it (same id), keeping its created_at. ErrLimit when a
// new one would exceed MaxAgents.
func (s *Store) SaveAgent(ctx context.Context, a Agent) (*Agent, error) {
	if a.SkillIDs == nil {
		a.SkillIDs = []string{}
	}
	if a.Chain == nil {
		a.Chain = []string{}
	}
	skillIDs, err := json.Marshal(a.SkillIDs)
	if err != nil {
		return nil, err
	}
	chain, err := json.Marshal(a.Chain)
	if err != nil {
		return nil, err
	}
	var options, think any
	if len(a.Options) > 0 {
		options = string(a.Options)
	}
	if a.Think != nil {
		think = 0
		if *a.Think {
			think = 1
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	created, err := createdAt(ctx, tx, "agents", a.ID, MaxAgents)
	if err != nil {
		return nil, err
	}
	now := nowString()
	if _, err := tx.ExecContext(ctx, `INSERT INTO agents(id, name, description, icon, model, instructions, options_json, think,
		skills_mode, skill_ids, created_at, updated_at, chain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, icon = excluded.icon,
		model = excluded.model, instructions = excluded.instructions, options_json = excluded.options_json,
		think = excluded.think, skills_mode = excluded.skills_mode, skill_ids = excluded.skill_ids, updated_at = excluded.updated_at,
		chain = excluded.chain`,
		a.ID, a.Name, a.Description, a.Icon, a.Model, a.Instructions, options, think, a.Skills, string(skillIDs), created, now, string(chain)); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	a.CreatedAt, a.UpdatedAt = created, now
	return &a, nil
}

// DeleteAgent removes one agent and takes it out of every chain that had it. ErrNotFound when
// there is none with that id. Conversations that used it keep the id; the browser treats an
// unknown agent as none.
func (s *Store) DeleteAgent(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := deleteRow(ctx, tx, "agents", id); err != nil {
		return err
	}
	if err := dropFromAgentLists(ctx, tx, "chain", id); err != nil {
		return err
	}
	return tx.Commit()
}

// ListSkills returns every skill, by name.
func (s *Store) ListSkills(ctx context.Context) ([]Skill, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, description, category, instructions, created_at, updated_at
		FROM skills ORDER BY name COLLATE NOCASE, id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Skill{}
	for rows.Next() {
		var k Skill
		if err := rows.Scan(&k.ID, &k.Name, &k.Description, &k.Category, &k.Instructions, &k.CreatedAt, &k.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// SaveSkill creates the skill or replaces it (same id), keeping its created_at. ErrLimit when a
// new one would exceed MaxSkills.
func (s *Store) SaveSkill(ctx context.Context, k Skill) (*Skill, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	created, err := createdAt(ctx, tx, "skills", k.ID, MaxSkills)
	if err != nil {
		return nil, err
	}
	now := nowString()
	if _, err := tx.ExecContext(ctx, `INSERT INTO skills(id, name, description, category, instructions, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, category = excluded.category,
		instructions = excluded.instructions, updated_at = excluded.updated_at`,
		k.ID, k.Name, k.Description, k.Category, k.Instructions, created, now); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	k.CreatedAt, k.UpdatedAt = created, now
	return &k, nil
}

// DeleteSkill removes one skill and takes it out of every agent that had selected it.
// ErrNotFound when there is none with that id.
func (s *Store) DeleteSkill(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := deleteRow(ctx, tx, "skills", id); err != nil {
		return err
	}
	if err := dropFromAgentLists(ctx, tx, "skill_ids", id); err != nil {
		return err
	}
	return tx.Commit()
}

// dropFromAgentLists takes id out of one JSON list column of every agent (skill_ids, chain).
func dropFromAgentLists(ctx context.Context, tx *sql.Tx, column, id string) error {
	var selectList, updateList string
	switch column {
	case "skill_ids":
		selectList, updateList = `SELECT id, skill_ids FROM agents`, `UPDATE agents SET skill_ids = ? WHERE id = ?`
	case "chain":
		selectList, updateList = `SELECT id, chain FROM agents`, `UPDATE agents SET chain = ? WHERE id = ?`
	default:
		return errors.New("history: not an agent list column: " + column)
	}
	rows, err := tx.QueryContext(ctx, selectList)
	if err != nil {
		return err
	}
	type change struct{ id, list string }
	var changes []change
	for rows.Next() {
		var agentID string
		var raw *string
		if err := rows.Scan(&agentID, &raw); err != nil {
			_ = rows.Close()
			return err
		}
		var ids []string
		if raw == nil || json.Unmarshal([]byte(*raw), &ids) != nil {
			continue
		}
		kept := make([]string, 0, len(ids))
		for _, other := range ids {
			if other != id {
				kept = append(kept, other)
			}
		}
		if len(kept) != len(ids) {
			b, _ := json.Marshal(kept)
			changes = append(changes, change{agentID, string(b)})
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, c := range changes {
		if _, err := tx.ExecContext(ctx, updateList, c.list, c.id); err != nil {
			return err
		}
	}
	return nil
}

type execQuerier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// createdAt returns the created_at to keep for id: the stored one, or now for a new row (after
// checking the table holds fewer than max rows). table is a constant of this file.
func createdAt(ctx context.Context, q execQuerier, table, id string, max int) (string, error) {
	var created string
	err := q.QueryRowContext(ctx, `SELECT created_at FROM `+table+` WHERE id = ?`, id).Scan(&created)
	if err == nil {
		return created, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	var n int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table).Scan(&n); err != nil {
		return "", err
	}
	if n >= max {
		return "", ErrLimit
	}
	return nowString(), nil
}

// deleteRow deletes table.id (table is a constant of this file); ErrNotFound when absent.
func deleteRow(ctx context.Context, q execQuerier, table, id string) error {
	res, err := q.ExecContext(ctx, `DELETE FROM `+table+` WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
