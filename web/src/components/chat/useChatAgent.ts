// The agent and skills of the chat on screen (SPEC §9.4): a conversation keeps its own (recorded
// by the computer on each turn), a new chat uses the draft chosen for that computer. Loads the
// computer's agents and skills, composes the system messages and tells when an agent's model
// is missing on that computer. With an agent chain (rev. 1.9, a computer with capability "chain"),
// the agents before the last one answer first; the last one's answer is the reply.

import { useEffect, useMemo } from "react";
import { activeSkills, chainAgents, composeSystem, type ChatSetup } from "@/lib/agents";
import type { Agent, Skill } from "@/protocol/channel";
import { chatStore, type Conversation } from "@/stores/chat";
import { EMPTY_LIBRARY, libraryStore, type DeviceLibrary } from "@/stores/library";
import { useLibrary, useModels, useSessions, useUi } from "@/stores/react";
import { uiStore } from "@/stores/ui";

export interface ChatAgent {
  library: DeviceLibrary;
  setup: ChatSetup;
  setSetup(next: ChatSetup): void;
  /** `null`: none, or an agent this computer no longer has. */
  agent: Agent | null;
  /** The skills that go along (the agent's, then the ones turned on in the chat). */
  skills: Skill[];
  /** The skills turned on in the chat that still exist (recorded with the conversation). */
  chatSkillIds: string[];
  system: string;
  /** The agent's model is not installed on the computer (known once its models were listed). */
  modelMissing: boolean;
  /** rev. 1.9: the agents of the agent's chain that the computer has, in order (empty: no chain). */
  chain: Agent[];
  /** The agent whose answer is the reply: the last of the chain, else the chat's agent. */
  final: Agent | null;
  /** The system message of `final` (the same as `system` without a chain). */
  finalSystem: string;
  /** The agents that answer before `final`, each with its own system message. */
  before: { agent: Agent; system: string }[];
  /** The first agent of the chat (or of its chain) whose model is not installed. */
  missingAgent: Agent | null;
}

export function useChatAgent(conv: Conversation | undefined, deviceId: string | null, reachable: boolean): ChatAgent {
  const library = useLibrary((s) => (deviceId ? s.byDevice[deviceId] : undefined)) ?? EMPTY_LIBRARY;
  const draft = useUi((s) => s.draftSetup);
  const models = useModels((s) => (deviceId ? s.byDevice[deviceId]?.models : undefined));
  const modelsLoaded = useModels((s) => (deviceId ? s.byDevice[deviceId]?.loaded_at != null : false));

  useEffect(() => {
    if (deviceId && reachable) void libraryStore.getState().load(deviceId);
  }, [deviceId, reachable]);

  const setup: ChatSetup = useMemo(() => {
    if (conv) return { agentId: conv.agent_id ?? null, skillIds: conv.skill_ids ?? [] };
    if (draft.deviceId && draft.deviceId === deviceId) return { agentId: draft.agentId, skillIds: draft.skillIds };
    return { agentId: null, skillIds: [] };
  }, [conv, draft, deviceId]);

  const setSetup = (next: ChatSetup) => {
    if (conv) {
      const updated: Conversation = { ...conv };
      if (next.agentId) updated.agent_id = next.agentId;
      else delete updated.agent_id;
      if (next.skillIds.length > 0) updated.skill_ids = next.skillIds;
      else delete updated.skill_ids;
      chatStore.getState().upsert(updated);
    } else {
      uiStore.getState().setDraftSetup({ deviceId, agentId: next.agentId, skillIds: next.skillIds });
    }
  };

  const agent = setup.agentId ? (library.agents.find((a) => a.id === setup.agentId) ?? null) : null;
  const skills = useMemo(() => activeSkills(agent, library.skills, setup.skillIds), [agent, library.skills, setup.skillIds]);
  const chatSkillIds = useMemo(() => setup.skillIds.filter((id) => library.skills.some((k) => k.id === id)), [setup.skillIds, library.skills]);
  const system = useMemo(() => composeSystem(agent, skills), [agent, skills]);
  const modelMissing = Boolean(agent && modelsLoaded && !(models ?? []).some((m) => m.name === agent.model));

  const chainSupported = useSessions((s) => Boolean(deviceId && s.sessions[deviceId]?.device_info?.capabilities.includes("chain")));
  const chain = useMemo(() => (chainSupported ? chainAgents(agent, library.agents) : []), [chainSupported, agent, library.agents]);
  const plan = useMemo(() => {
    if (!agent || chain.length === 0) return { final: agent, finalSystem: system, before: [] as { agent: Agent; system: string }[] };
    const all = [agent, ...chain];
    const systemOf = (a: Agent) => composeSystem(a, activeSkills(a, library.skills, setup.skillIds));
    const last = all[all.length - 1] as Agent;
    return { final: last, finalSystem: systemOf(last), before: all.slice(0, -1).map((a) => ({ agent: a, system: systemOf(a) })) };
  }, [agent, chain, system, library.skills, setup.skillIds]);
  const missingAgent = modelsLoaded && agent ? ([agent, ...chain].find((a) => !(models ?? []).some((m) => m.name === a.model)) ?? null) : null;

  return { library, setup, setSetup, agent, skills, chatSkillIds, system, modelMissing, chain, ...plan, missingAgent };
}
