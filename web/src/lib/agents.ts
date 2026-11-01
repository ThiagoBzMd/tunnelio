// Agents and skills in a chat (SPEC §9.4): which skills apply, and the system message the
// browser composes from the agent's instructions and those skills (their whole text). The
// computer only stores agents and skills; it never builds prompts. An agent chain (rev. 1.9) runs
// here too: each agent after the first gets the previous agent's answer in its system message.

import { randomUuid } from "../crypto/uuid";
import type { Agent, AgentInput, Skill, SkillInput } from "../protocol/channel";
import { LIMITS } from "../protocol/constants";

/** What a chat applies: an agent (or none) and the skills turned on in this chat. */
export interface ChatSetup {
  agentId: string | null;
  skillIds: string[];
}

export const NO_SETUP: ChatSetup = { agentId: null, skillIds: [] };

/** The skills an agent brings by itself: none, all of the computer, or the selected ones. */
export function agentSkills(agent: Agent | null | undefined, skills: Skill[]): Skill[] {
  if (!agent || agent.skills === "off") return [];
  if (agent.skills === "all") return skills;
  const byId = new Map(skills.map((k) => [k.id, k]));
  return agent.skill_ids.map((id) => byId.get(id)).filter((k): k is Skill => Boolean(k));
}

/** The agent's skills plus the ones turned on in the chat, each once, in that order. */
export function activeSkills(agent: Agent | null | undefined, skills: Skill[], chatSkillIds: readonly string[]): Skill[] {
  const out = agentSkills(agent, skills);
  const seen = new Set(out.map((k) => k.id));
  const byId = new Map(skills.map((k) => [k.id, k]));
  for (const id of chatSkillIds) {
    const k = byId.get(id);
    if (k && !seen.has(id)) {
      out.push(k);
      seen.add(id);
    }
  }
  return out;
}

/**
 * The system message: the agent's instructions, then every active skill (name, when it applies,
 * its instructions). Empty when there is nothing to say.
 */
export function composeSystem(agent: Agent | null | undefined, skills: Skill[]): string {
  const parts: string[] = [];
  const instructions = agent?.instructions.trim() ?? "";
  if (instructions) parts.push(instructions);
  const withText = skills.filter((k) => k.instructions.trim() || k.description.trim());
  if (withText.length > 0) {
    const blocks = withText.map((k) => {
      const lines = [`## ${k.name}`];
      if (k.description.trim()) lines.push(`When to use: ${k.description.trim()}`);
      if (k.instructions.trim()) lines.push("", k.instructions.trim());
      return lines.join("\n");
    });
    parts.push(["# Skills", "Each skill below holds instructions for a kind of request. Follow a skill when its description fits the request.", ...blocks].join("\n\n"));
  }
  return parts.join("\n\n");
}

/** The agents of `agent`'s chain that the computer still has, in order (never itself, ≤ 5). */
export function chainAgents(agent: Agent | null | undefined, agents: Agent[]): Agent[] {
  if (!agent?.chain?.length) return [];
  const byId = new Map(agents.map((a) => [a.id, a]));
  return agent.chain
    .filter((id) => id !== agent.id)
    .map((id) => byId.get(id))
    .filter((a): a is Agent => Boolean(a))
    .slice(0, LIMITS.CHAIN_MAX);
}

/**
 * The system message of agent `step` (2…total) of a chain: its own (instructions and skills), then
 * its place in the chain and the previous agent's answer, to build on.
 */
export function chainSystem(own: string, step: number, total: number, previous: { name: string; content: string }): string {
  const name = previous.name.replace(/"/g, "'");
  const note = [
    "# Agent chain",
    `You are agent ${step} of ${total} answering the user's last message, one after the other. The previous agent, ${name}, answered as below. Build on that answer (check, correct, complete or improve it, as your own instructions say) and write your own answer to the user. Do not mention the chain or the other agents.`,
    `<previous_answer agent="${name}">\n${previous.content.trim()}\n</previous_answer>`,
  ].join("\n\n");
  return own.trim() ? `${own.trim()}\n\n${note}` : note;
}

export function newAgent(model: string): AgentInput {
  return { id: randomUuid(), name: "", description: "", icon: "bot", model, instructions: "", skills: "off", skill_ids: [] };
}

export function newSkill(): SkillInput {
  return { id: randomUuid(), name: "", description: "", category: "", instructions: "" };
}

/** The editable part of a saved agent / skill (what goes back in agent_save / skill_save). */
export function agentInput(a: Agent): AgentInput {
  const out: AgentInput = { id: a.id, name: a.name, description: a.description, icon: a.icon, model: a.model, instructions: a.instructions, skills: a.skills, skill_ids: [...a.skill_ids] };
  if (a.options && Object.keys(a.options).length > 0) out.options = { ...a.options };
  if (a.think !== undefined) out.think = a.think;
  if (a.chain && a.chain.length > 0) out.chain = [...a.chain];
  return out;
}

export function skillInput(k: Skill): SkillInput {
  return { id: k.id, name: k.name, description: k.description, category: k.category, instructions: k.instructions };
}

/** A copy under a new id ("Name (copy)"), not saved yet. */
export function duplicateAgent(a: AgentInput, suffix: string): AgentInput {
  return {
    ...a,
    id: randomUuid(),
    name: `${a.name} ${suffix}`.trim().slice(0, 80),
    skill_ids: [...a.skill_ids],
    ...(a.options ? { options: { ...a.options } } : {}),
    ...(a.chain ? { chain: [...a.chain] } : {}),
  };
}
