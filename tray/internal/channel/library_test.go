package channel_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/ThiagoBzMd/tunnelio/tray/internal/history"
)

const (
	testAgentID = "aaaaaaaa-0000-4000-8000-000000000001"
	testSkillID = "bbbbbbbb-0000-4000-8000-000000000001"
)

func TestAgentsAndSkills(t *testing.T) {
	h := newHarness(t, harnessOpts{burst: 200})
	h.ollama.ChatTokens = []string{"Short", " answer"}
	b := h.open("c1")
	b.handshake(true)

	expectInvalid := func(id string, msg map[string]any, why string) {
		t.Helper()
		msg["id"] = id
		b.send(msg)
		if m := b.recvType("error"); m["code"] != "E_INVALID" || m["id"] != id {
			t.Errorf("%s: want E_INVALID, got %v", why, m)
		}
	}

	// Skills: saved, listed; an unknown category or a nameless skill is refused.
	skill := map[string]any{"id": testSkillID, "name": "  Tone  ", "description": "When writing to patients", "category": "writing", "instructions": "# Tone\nWarm and plain."}
	b.send(map[string]any{"type": "skill_save", "id": "s1", "skill": skill})
	saved := b.recvType("skill")
	if k, _ := saved["skill"].(map[string]any); k["name"] != "Tone" || k["created_at"] == "" || k["category"] != "writing" {
		t.Fatalf("skill_save = %v", saved)
	}
	expectInvalid("s2", map[string]any{"type": "skill_save", "skill": map[string]any{"id": testSkillID, "name": "x", "category": "cooking"}}, "category")
	expectInvalid("s3", map[string]any{"type": "skill_save", "skill": map[string]any{"id": testSkillID, "name": "  "}}, "empty name")
	expectInvalid("s4", map[string]any{"type": "skill_save", "skill": map[string]any{"id": "not-a-uuid", "name": "x"}}, "id")
	expectInvalid("s5", map[string]any{"type": "skill_save", "skill": map[string]any{"id": testSkillID, "name": "x", "instructions": strings.Repeat("a", 32<<10+1)}}, "instructions too long")
	expectInvalid("s6", map[string]any{"type": "skill_save", "skill": map[string]any{"id": testSkillID, "name": "a\x00b"}}, "control character")

	// Agents: options go through the same checks as chat options; the model name is checked.
	agent := map[string]any{"id": testAgentID, "name": "Writer", "description": "Writes letters", "icon": "feather", "model": "fake:latest",
		"instructions": "Answer in two words.", "options": map[string]any{"temperature": 0.3}, "think": false, "skills": "selected", "skill_ids": []string{testSkillID, testSkillID}}
	b.send(map[string]any{"type": "agent_save", "id": "a1", "agent": agent})
	a := b.recvType("agent")["agent"].(map[string]any)
	if a["name"] != "Writer" || a["icon"] != "feather" || len(a["skill_ids"].([]any)) != 1 || a["options"].(map[string]any)["temperature"] != 0.3 || a["think"] != false {
		t.Fatalf("agent_save = %v", a)
	}
	bad := func(field string, v any) map[string]any {
		c := map[string]any{}
		for k, x := range agent {
			c[k] = x
		}
		c[field] = v
		return map[string]any{"type": "agent_save", "agent": c}
	}
	expectInvalid("a2", bad("options", map[string]any{"temperature": 5}), "temperature out of range")
	expectInvalid("a3", bad("options", map[string]any{"mirostat": 1}), "unknown option")
	expectInvalid("a4", bad("model", "../etc"), "model name")
	expectInvalid("a5", bad("skills", "some"), "skills mode")
	expectInvalid("a6", bad("icon", "Bad Icon"), "icon")
	expectInvalid("a7", bad("skill_ids", []string{"nope"}), "skill id")
	expectInvalid("a8", map[string]any{"type": "agent_save"}, "no agent")

	b.send(map[string]any{"type": "agent_list", "id": "l1"})
	if list := b.recvType("agents")["agents"].([]any); len(list) != 1 {
		t.Fatalf("agent_list = %v", list)
	}
	b.send(map[string]any{"type": "skill_list", "id": "l2"})
	if list := b.recvType("skills")["skills"].([]any); len(list) != 1 {
		t.Fatalf("skill_list = %v", list)
	}

	// A chat with the agent: the system message the browser composed reaches Ollama, is not kept
	// as a message, and the conversation remembers the agent and the skills.
	conv, _ := history.NewUUID()
	done, errMsg := b.runChat("c1", map[string]any{"conversation_id": conv, "mode": "private", "model": "fake:latest",
		"agent_id": testAgentID, "skill_ids": []string{testSkillID},
		"messages": []map[string]any{{"role": "system", "content": "Answer in two words."}, {"role": "user", "content": "hello"}}})
	if errMsg != nil || done["done_reason"] != "stop" {
		t.Fatalf("chat with agent = %v / %v", done, errMsg)
	}
	if req := h.ollama.LastRequest("/api/chat"); req == nil || !strings.Contains(string(req.Raw), "Answer in two words.") {
		t.Errorf("the system message must reach Ollama")
	}
	b.send(map[string]any{"type": "history_get", "id": "g1", "conversation_id": conv})
	got := b.recvType("conversation")
	head := got["conversation"].(map[string]any)
	if head["agent_id"] != testAgentID || len(head["skill_ids"].([]any)) != 1 || len(got["messages"].([]any)) != 2 {
		t.Errorf("history_get = %v", got)
	}
	b.send(map[string]any{"type": "history_list", "id": "g2"})
	if c := b.recvType("history")["conversations"].([]any)[0].(map[string]any); c["agent_id"] != testAgentID {
		t.Errorf("history_list = %v", c)
	}
	// The next turn without an agent clears it.
	if done, _ := b.runChat("c2", map[string]any{"conversation_id": conv, "mode": "private", "model": "fake:latest",
		"messages": []map[string]any{{"role": "user", "content": "again"}}}); done == nil {
		t.Fatal("second turn failed")
	}
	if c, _, _, _ := h.history.Get(context.Background(), conv, 0, 1); c.AgentID != "" || c.SkillIDs != nil {
		t.Errorf("after a turn without agent = %+v", c)
	}
	if _, errMsg := b.runChat("c3", map[string]any{"conversation_id": conv, "mode": "private", "model": "fake:latest", "agent_id": "x",
		"messages": []map[string]any{{"role": "user", "content": "x"}}}); errMsg == nil || errMsg["code"] != "E_INVALID" {
		t.Errorf("bad agent_id = %v", errMsg)
	}

	// Deleting the skill takes it out of the agent; deleting twice is E_NOT_FOUND.
	b.send(map[string]any{"type": "skill_delete", "id": "d1", "skill_id": testSkillID})
	if m := b.recv(wait); m["type"] != "ok" {
		t.Fatalf("skill_delete = %v", m)
	}
	b.send(map[string]any{"type": "agent_list", "id": "l3"})
	if a := b.recvType("agents")["agents"].([]any)[0].(map[string]any); len(a["skill_ids"].([]any)) != 0 {
		t.Errorf("agent after skill_delete = %v", a)
	}
	b.send(map[string]any{"type": "agent_delete", "id": "d2", "agent_id": testAgentID})
	if m := b.recv(wait); m["type"] != "ok" {
		t.Fatalf("agent_delete = %v", m)
	}
	b.send(map[string]any{"type": "agent_delete", "id": "d3", "agent_id": testAgentID})
	if m := b.recvType("error"); m["code"] != "E_NOT_FOUND" {
		t.Errorf("second agent_delete = %v", m)
	}
}

func TestAgentChains(t *testing.T) {
	h := newHarness(t, harnessOpts{burst: 200})
	h.ollama.ChatTokens = []string{"Final", " answer"}
	b := h.open("c1")
	b.handshake(true)
	expectInvalid := func(id string, msg map[string]any, why string) {
		t.Helper()
		msg["id"] = id
		b.send(msg)
		if m := b.recvType("error"); m["code"] != "E_INVALID" || m["id"] != id {
			t.Errorf("%s: want E_INVALID, got %v", why, m)
		}
	}
	other := "aaaaaaaa-0000-4000-8000-0000000000f2"
	agent := func(chain any) map[string]any {
		return map[string]any{"type": "agent_save", "agent": map[string]any{"id": testAgentID, "name": "Lead", "model": "fake:latest",
			"skills": "off", "skill_ids": []string{}, "chain": chain}}
	}
	// agent.chain: other agents, each once, at most five; the order is kept.
	msg := agent([]string{other, testSkillID})
	msg["id"] = "a1"
	b.send(msg)
	if a := b.recvType("agent")["agent"].(map[string]any); fmt.Sprint(a["chain"]) != "["+other+" "+testSkillID+"]" {
		t.Fatalf("agent_save with a chain = %v", a)
	}
	expectInvalid("a2", agent([]string{testAgentID}), "itself")
	expectInvalid("a3", agent([]string{other, other}), "repeated")
	expectInvalid("a4", agent([]string{"x"}), "not a UUID")
	six := []string{}
	for i := 0; i < 6; i++ {
		six = append(six, fmt.Sprintf("aaaaaaaa-0000-4000-8000-00000000010%d", i))
	}
	expectInvalid("a5", agent(six), "too long")

	// chat.chain: the earlier answers are kept with the assistant message, never sent to Ollama.
	conv, _ := history.NewUUID()
	step := map[string]any{"agent_id": testAgentID, "name": "Lead", "model": "fake:latest", "content": "a first draft"}
	done, errMsg := b.runChat("c1", map[string]any{"conversation_id": conv, "mode": "private", "model": "fake:latest", "agent_id": testAgentID,
		"chain":    []map[string]any{step},
		"messages": []map[string]any{{"role": "system", "content": "Improve the draft."}, {"role": "user", "content": "hello"}}})
	if errMsg != nil || done["done_reason"] != "stop" {
		t.Fatalf("chat with a chain = %v / %v", done, errMsg)
	}
	if req := h.ollama.LastRequest("/api/chat"); req == nil || strings.Contains(string(req.Raw), "a first draft") {
		t.Errorf("chat.chain must not reach Ollama")
	}
	_, msgs, _, err := h.history.Get(context.Background(), conv, 0, 0)
	if err != nil || len(msgs) != 2 || msgs[0].Chain != nil || len(msgs[1].Chain) != 1 || msgs[1].Chain[0].Content != "a first draft" || msgs[1].Content != "Final answer" {
		t.Fatalf("history after a chained answer = %+v, %v", msgs, err)
	}
	bad := func(field string, v any) []map[string]any {
		c := map[string]any{}
		for k, x := range step {
			c[k] = x
		}
		c[field] = v
		return []map[string]any{c}
	}
	for i, chain := range [][]map[string]any{bad("agent_id", "x"), bad("name", " "), bad("model", "../m"), bad("content", strings.Repeat("a", 512<<10+1))} {
		_, errMsg := b.runChat(fmt.Sprintf("b%d", i), map[string]any{"conversation_id": conv, "mode": "private", "model": "fake:latest",
			"chain": chain, "messages": []map[string]any{{"role": "user", "content": "x"}}})
		if errMsg == nil || errMsg["code"] != "E_INVALID" {
			t.Errorf("bad chain %d = %v", i, errMsg)
		}
	}
}
