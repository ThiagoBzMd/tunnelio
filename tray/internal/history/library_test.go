package history

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
)

func TestAgentsSaveListDelete(t *testing.T) {
	s := openTemp(t)
	ctx := context.Background()
	if list, err := s.ListAgents(ctx); err != nil || len(list) != 0 {
		t.Fatalf("empty list = %v, %v", list, err)
	}
	think := true
	a := Agent{ID: "aaaaaaaa-0000-4000-8000-000000000001", Name: "writer", Description: "Writes", Icon: "feather", Model: "qwen2.5:0.5b",
		Instructions: "Be brief.", Options: json.RawMessage(`{"temperature":0.2}`), Think: &think, Skills: "selected",
		SkillIDs: []string{"bbbbbbbb-0000-4000-8000-000000000001"}}
	saved, err := s.SaveAgent(ctx, a)
	if err != nil || saved.CreatedAt == "" || saved.UpdatedAt != saved.CreatedAt {
		t.Fatalf("SaveAgent = %+v, %v", saved, err)
	}
	other := Agent{ID: "aaaaaaaa-0000-4000-8000-000000000002", Name: "Analyst", Model: "llama3.2:3b", Skills: "off"}
	if _, err := s.SaveAgent(ctx, other); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListAgents(ctx)
	if err != nil || len(list) != 2 || list[0].Name != "Analyst" || list[1].Name != "writer" {
		t.Fatalf("list by name (case-insensitive) = %+v, %v", list, err)
	}
	got := list[1]
	if string(got.Options) != `{"temperature":0.2}` || got.Think == nil || !*got.Think || len(got.SkillIDs) != 1 || got.Instructions != "Be brief." {
		t.Errorf("round trip = %+v", got)
	}
	if list[0].SkillIDs == nil || list[0].Think != nil || list[0].Options != nil {
		t.Errorf("an agent without skills/think/options = %+v", list[0])
	}

	// Saving again replaces the fields and keeps created_at.
	a.Name, a.Think, a.Options = "Writer", nil, nil
	again, err := s.SaveAgent(ctx, a)
	if err != nil || again.CreatedAt != saved.CreatedAt {
		t.Fatalf("resave = %+v, %v", again, err)
	}
	list, _ = s.ListAgents(ctx)
	if list[1].Name != "Writer" || list[1].Think != nil || list[1].Options != nil {
		t.Errorf("after resave = %+v", list[1])
	}

	if err := s.DeleteAgent(ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteAgent(ctx, a.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("second delete = %v", err)
	}
	if list, _ := s.ListAgents(ctx); len(list) != 1 {
		t.Errorf("after delete = %+v", list)
	}
}

func TestSkillsDeleteLeavesAgentsAndLimit(t *testing.T) {
	s := openTemp(t)
	ctx := context.Background()
	k1 := Skill{ID: "bbbbbbbb-0000-4000-8000-000000000001", Name: "Tone", Description: "When writing", Category: "writing", Instructions: "# Tone\nWarm."}
	k2 := Skill{ID: "bbbbbbbb-0000-4000-8000-000000000002", Name: "Code review", Category: "code", Instructions: "Check tests."}
	for _, k := range []Skill{k1, k2} {
		if _, err := s.SaveSkill(ctx, k); err != nil {
			t.Fatal(err)
		}
	}
	agent := Agent{ID: "aaaaaaaa-0000-4000-8000-000000000001", Name: "A", Model: "m:1", Skills: "selected", SkillIDs: []string{k1.ID, k2.ID}}
	if _, err := s.SaveAgent(ctx, agent); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteSkill(ctx, k1.ID); err != nil {
		t.Fatal(err)
	}
	skills, _ := s.ListSkills(ctx)
	if len(skills) != 1 || skills[0].ID != k2.ID || skills[0].Category != "code" {
		t.Errorf("skills after delete = %+v", skills)
	}
	agents, _ := s.ListAgents(ctx)
	if len(agents[0].SkillIDs) != 1 || agents[0].SkillIDs[0] != k2.ID {
		t.Errorf("the deleted skill must leave the agent: %+v", agents[0].SkillIDs)
	}
	if err := s.DeleteSkill(ctx, k1.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("second delete = %v", err)
	}

	// At most MaxSkills: a new one past the limit is refused, saving an existing one is not.
	for i := len(skills); i < MaxSkills; i++ {
		if _, err := s.SaveSkill(ctx, Skill{ID: fmt.Sprintf("cccccccc-0000-4000-8000-%012d", i), Name: "s"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.SaveSkill(ctx, Skill{ID: "dddddddd-0000-4000-8000-000000000001", Name: "one too many"}); !errors.Is(err, ErrLimit) {
		t.Errorf("past the limit = %v", err)
	}
	if _, err := s.SaveSkill(ctx, k2); err != nil {
		t.Errorf("resave at the limit = %v", err)
	}

	// Deleting every conversation keeps agents and skills.
	if err := s.Clear(ctx); err != nil {
		t.Fatal(err)
	}
	if a, _ := s.ListAgents(ctx); len(a) != 1 {
		t.Errorf("agents after Clear = %d", len(a))
	}
}

func TestConversationSetup(t *testing.T) {
	s := openTemp(t)
	ctx := context.Background()
	id := "11111111-1111-4111-8111-111111111111"
	if err := s.SetConversationSetup(ctx, id, "aaaaaaaa-0000-4000-8000-000000000001", nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown conversation = %v", err)
	}
	if _, err := s.EnsureConversation(ctx, id, "t", "m:1"); err != nil {
		t.Fatal(err)
	}
	skills := []string{"bbbbbbbb-0000-4000-8000-000000000001"}
	if err := s.SetConversationSetup(ctx, id, "aaaaaaaa-0000-4000-8000-000000000001", skills); err != nil {
		t.Fatal(err)
	}
	list, _, _ := s.List(ctx, 10, "")
	if list[0].AgentID != "aaaaaaaa-0000-4000-8000-000000000001" || len(list[0].SkillIDs) != 1 {
		t.Errorf("list = %+v", list[0])
	}
	// Back to none: no agent, no skills (fields left out of the JSON).
	if err := s.SetConversationSetup(ctx, id, "", nil); err != nil {
		t.Fatal(err)
	}
	c, _, _, _ := s.Get(ctx, id, 0, 1)
	b, _ := json.Marshal(c)
	if c.AgentID != "" || c.SkillIDs != nil || string(b) != fmt.Sprintf(`{"id":"%s","title":"t","model":"m:1","created_at":"%s","updated_at":"%s","message_count":0}`, id, c.CreatedAt, c.UpdatedAt) {
		t.Errorf("cleared = %s", b)
	}
}

func TestAgentChainsAndChainedAnswers(t *testing.T) {
	s := openTemp(t)
	ctx := context.Background()
	ids := []string{"aaaaaaaa-0000-4000-8000-00000000000a", "aaaaaaaa-0000-4000-8000-00000000000b", "aaaaaaaa-0000-4000-8000-00000000000c"}
	for _, id := range ids[1:] {
		if _, err := s.SaveAgent(ctx, Agent{ID: id, Name: id[len(id)-1:], Model: "m", Skills: "off"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.SaveAgent(ctx, Agent{ID: ids[0], Name: "lead", Model: "m", Skills: "off", Chain: []string{ids[1], ids[2]}}); err != nil {
		t.Fatal(err)
	}
	chainOf := func(id string) []string {
		list, err := s.ListAgents(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, a := range list {
			if a.ID == id {
				return a.Chain
			}
		}
		t.Fatalf("agent %s not listed", id)
		return nil
	}
	if got := chainOf(ids[0]); len(got) != 2 || got[0] != ids[1] || got[1] != ids[2] {
		t.Fatalf("chain round trip = %v", got)
	}
	if got := chainOf(ids[1]); got == nil || len(got) != 0 {
		t.Errorf("an agent without a chain lists [] = %#v", got)
	}
	// Deleting an agent takes it out of every chain, keeping the order of the rest.
	if err := s.DeleteAgent(ctx, ids[1]); err != nil {
		t.Fatal(err)
	}
	if got := chainOf(ids[0]); len(got) != 1 || got[0] != ids[2] {
		t.Errorf("chain after deleting a member = %v", got)
	}

	// An assistant message keeps the answers of the earlier agents; other roles cannot.
	conv, _ := NewUUID()
	if _, err := s.EnsureConversation(ctx, conv, "t", "m"); err != nil {
		t.Fatal(err)
	}
	steps := []ChainStep{{AgentID: ids[0], Name: "lead", Model: "m", Content: "draft"}, {AgentID: ids[2], Name: "c", Model: "m", Content: "review"}}
	if _, err := s.AppendMessage(ctx, conv, NewMessage{Role: "user", Content: "q", Chain: steps}); err == nil {
		t.Error("a user message took a chain")
	}
	if _, err := s.AppendMessage(ctx, conv, NewMessage{Role: "user", Content: "q"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendMessage(ctx, conv, NewMessage{Role: "assistant", Content: "final", Chain: steps}); err != nil {
		t.Fatal(err)
	}
	_, msgs, _, err := s.Get(ctx, conv, 0, 0)
	if err != nil || len(msgs) != 2 {
		t.Fatalf("Get = %+v, %v", msgs, err)
	}
	if msgs[0].Chain != nil || len(msgs[1].Chain) != 2 || msgs[1].Chain[1] != steps[1] {
		t.Errorf("chained answer round trip = %+v", msgs)
	}
}
