import { describe, expect, it } from "vitest";
import { activeSkills, agentInput, agentSkills, chainAgents, chainSystem, composeSystem, duplicateAgent, newAgent, newSkill } from "../src/lib/agents";
import { ChannelValidationError, parseInboundMessage, validateOutbound, type Agent, type Skill } from "../src/protocol/channel";
import { withSystem } from "../src/stores/chat";

const skill = (id: string, name: string, extra: Partial<Skill> = {}): Skill => ({
  id,
  name,
  description: `When ${name}`,
  category: "writing",
  instructions: `Do ${name}.`,
  created_at: "t",
  updated_at: "t",
  ...extra,
});
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const K1 = "bbbbbbbb-0000-4000-8000-000000000001";
const K2 = "bbbbbbbb-0000-4000-8000-000000000002";
const agent = (extra: Partial<Agent> = {}): Agent => ({
  id: A,
  name: "Writer",
  description: "",
  icon: "feather",
  model: "llama3.2:3b",
  instructions: "Be brief.",
  skills: "selected",
  skill_ids: [K2],
  created_at: "t",
  updated_at: "t",
  ...extra,
});

describe("agents and skills", () => {
  const skills = [skill(K1, "tone"), skill(K2, "review", { description: "", category: "code" })];

  it("which skills go along: off, all, selected; then the chat's own, each once", () => {
    expect(agentSkills(agent({ skills: "off" }), skills)).toEqual([]);
    expect(agentSkills(agent({ skills: "all" }), skills).map((k) => k.name)).toEqual(["tone", "review"]);
    expect(agentSkills(agent(), skills).map((k) => k.name)).toEqual(["review"]);
    expect(agentSkills(agent({ skill_ids: ["gone"] }), skills)).toEqual([]);
    expect(activeSkills(agent(), skills, [K1, K2, "gone"]).map((k) => k.name)).toEqual(["review", "tone"]);
    expect(activeSkills(null, skills, [K1]).map((k) => k.name)).toEqual(["tone"]);
  });

  it("the system message: the agent's instructions, then each skill with when it applies", () => {
    const text = composeSystem(agent(), activeSkills(agent(), skills, [K1]));
    expect(text.startsWith("Be brief.\n\n# Skills\n\n")).toBe(true);
    expect(text).toContain("## review\n\nDo review.");
    expect(text).toContain("## tone\nWhen to use: When tone\n\nDo tone.");
    expect(text.indexOf("## review")).toBeLessThan(text.indexOf("## tone"));
    expect(composeSystem(null, [])).toBe("");
    expect(composeSystem(agent({ instructions: "  " }), [])).toBe("");
    expect(composeSystem(null, [skill(K1, "x", { description: " ", instructions: " " })])).toBe("");
  });

  it("the system message goes first and the oldest turns make room for it", () => {
    const wire = Array.from({ length: 500 }, (_, i) => ({ role: "user" as const, content: String(i) }));
    const out = withSystem("S", wire);
    expect(out).toHaveLength(500);
    expect(out[0]).toEqual({ role: "system", content: "S" });
    expect(out[1]?.content).toBe("1");
    expect(withSystem(" ", wire)).toBe(wire);
  });

  it("editing helpers: a new agent, the editable part of a saved one, a copy", () => {
    expect(newAgent("m:1")).toMatchObject({ name: "", icon: "bot", model: "m:1", skills: "off", skill_ids: [] });
    expect(newSkill()).toMatchObject({ name: "", category: "", instructions: "" });
    const input = agentInput(agent({ options: { temperature: 0.2 }, think: true }));
    expect(input).not.toHaveProperty("created_at");
    expect(input).toMatchObject({ options: { temperature: 0.2 }, think: true });
    const copy = duplicateAgent(input, "(copy)");
    expect(copy.id).not.toBe(input.id);
    expect(copy.name).toBe("Writer (copy)");
    copy.skill_ids.push("x");
    expect(input.skill_ids).toEqual([K2]);
  });

  it("requests are checked like the computer checks them; replies are validated", () => {
    const ok = { type: "agent_save" as const, id: "r1", agent: agentInput(agent()) };
    expect(() => validateOutbound(ok)).not.toThrow();
    const bad = (patch: Record<string, unknown>) => () => validateOutbound({ ...ok, agent: { ...ok.agent, ...patch } } as typeof ok);
    expect(bad({ name: "  " })).toThrow(ChannelValidationError);
    expect(bad({ name: "x".repeat(81) })).toThrow(ChannelValidationError);
    expect(bad({ icon: "Bad Icon" })).toThrow(ChannelValidationError);
    expect(bad({ model: "" })).toThrow(ChannelValidationError);
    expect(bad({ skills: "some" })).toThrow(ChannelValidationError);
    expect(bad({ skill_ids: ["nope"] })).toThrow(ChannelValidationError);
    expect(bad({ instructions: "x".repeat(32 * 1024 + 1) })).toThrow(ChannelValidationError);
    expect(bad({ description: "line one\nline two" })).not.toThrow();
    expect(bad({ name: "a\u0000b" })).toThrow(ChannelValidationError);
    const sk = { type: "skill_save" as const, id: "r2", skill: { id: K1, name: "Tone", description: "When", category: "writing" as const, instructions: "" } };
    expect(() => validateOutbound(sk)).not.toThrow();
    expect(() => validateOutbound({ ...sk, skill: { ...sk.skill, category: "cooking" as never } })).toThrow(ChannelValidationError);
    expect(() => validateOutbound({ type: "agent_delete", id: "r3", agent_id: "x" })).toThrow(ChannelValidationError);
    expect(() => validateOutbound({ type: "chat", id: "r4", conversation_id: A, mode: "private", model: "m", messages: [{ role: "user", content: "x" }], agent_id: "x" })).toThrow(ChannelValidationError);

    expect(parseInboundMessage({ type: "agents", id: "r1", agents: [agent()] }).ok).toBe(true);
    expect(parseInboundMessage({ type: "agents", id: "r1", agents: [{ ...agent(), skills: "some" }] }).ok).toBe(false);
    expect(parseInboundMessage({ type: "skill", id: "r2", skill: skills[0] }).ok).toBe(true);
    expect(parseInboundMessage({ type: "skills", id: "r2", skills: [{ id: K1 }] }).ok).toBe(false);
  });

  it("agent chains: the members the computer has, in order; the note with the previous answer; the checks", () => {
    const B = "aaaaaaaa-0000-4000-8000-000000000002";
    const C = "aaaaaaaa-0000-4000-8000-000000000003";
    const lead = agent({ chain: [C, "gone", A, B] });
    const all = [lead, agent({ id: B, name: "B" }), agent({ id: C, name: "C" })];
    expect(chainAgents(lead, all).map((a) => a.id)).toEqual([C, B]);
    expect(chainAgents(agent(), all)).toEqual([]);
    expect(chainAgents(null, all)).toEqual([]);
    const note = chainSystem("Review it.", 2, 3, { name: 'The "Drafter"', content: "  A draft.  " });
    expect(note.startsWith("Review it.\n\n# Agent chain\n\nYou are agent 2 of 3")).toBe(true);
    expect(note.endsWith(`<previous_answer agent="The 'Drafter'">\nA draft.\n</previous_answer>`)).toBe(true);
    expect(chainSystem("", 2, 2, { name: "x", content: "y" }).startsWith("# Agent chain")).toBe(true);
    // The editable part and a copy keep the chain.
    expect(agentInput(lead).chain).toEqual([C, "gone", A, B]);
    expect(duplicateAgent(agentInput(lead), "(copy)").chain).toEqual([C, "gone", A, B]);
    // Checked like the computer checks them.
    const save = (chain: string[]) => () => validateOutbound({ type: "agent_save", id: "r1", agent: { ...agentInput(agent()), chain } });
    expect(save([B, C])).not.toThrow();
    expect(save([A])).toThrow(ChannelValidationError);
    expect(save([B, B])).toThrow(ChannelValidationError);
    expect(save(["nope"])).toThrow(ChannelValidationError);
    expect(save(Array.from({ length: 6 }, (_, i) => `aaaaaaaa-0000-4000-8000-00000000010${i}`))).toThrow(ChannelValidationError);
    const chat = (chain: unknown) => () =>
      validateOutbound({ type: "chat", id: "r2", conversation_id: A, mode: "private", model: "m", messages: [{ role: "user", content: "x" }], chain: chain as never });
    const step = { agent_id: B, name: "B", model: "m", content: "draft" };
    expect(chat([step])).not.toThrow();
    expect(chat([{ ...step, agent_id: "x" }])).toThrow(ChannelValidationError);
    expect(chat([{ ...step, name: " " }])).toThrow(ChannelValidationError);
    expect(chat([{ ...step, content: "x".repeat(512 * 1024 + 1) }])).toThrow(ChannelValidationError);
    expect(chat(Array.from({ length: 6 }, () => step))).toThrow(ChannelValidationError);
    // Replies: agents may carry a chain; stored messages may carry the earlier answers.
    expect(parseInboundMessage({ type: "agents", id: "r1", agents: [lead] }).ok).toBe(true);
    expect(parseInboundMessage({ type: "agents", id: "r1", agents: [{ ...lead, chain: [1] }] }).ok).toBe(false);
  });
});
