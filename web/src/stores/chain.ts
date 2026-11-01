// Agent chains (SPEC §9.4, rev. 1.9): before the final agent answers, each earlier agent answers in
// turn as an anonymous chat that the computer does not keep (mode "incognito"); each one after the
// first gets the previous answer in its system message (lib/agents.ts chainSystem). The answers
// then travel with the final request (`chat.chain`) and the computer keeps them with the reply.

import { chainSystem } from "../lib/agents";
import { planContext } from "../lib/context";
import type { ChainStep, ChatDoneMessage, ChatOptions, ChatRequest } from "../protocol/channel";
import { LIMITS } from "../protocol/constants";
import { newRequestId } from "../protocol/ids";
import type { DeviceSession } from "../session/device-session";
import type { ChatMessage } from "./chat";
import { contextLengthOf, fitImagesToBudget, toWire, withSystem } from "./chat";
import { loadedContext, modelsStore } from "./models";

/** One agent that answers before the final one. */
export interface ChainRun {
  agent_id: string;
  name: string;
  model: string;
  /** Its own system message (instructions and skills); the previous answer is added here. */
  system: string;
  options?: ChatOptions;
  /** The agent's thinking setting (sent only to models that advertise thinking). */
  think?: boolean;
}

export interface ChainHooks {
  /** A new request starts (the one `abort` must target). */
  onRequest(requestId: string): void;
  /** Step `index` grew (its answer so far). */
  onStep(index: number, step: ChainStep): void;
  onStalled(): void;
}

export type ChainOutcome = { reason: "stop"; steps: ChainStep[] } | { reason: "abort" | "error"; steps: ChainStep[]; message?: string };

/** Too long for one of the chain's models. */
export class ChainTooLongError extends Error {
  constructor(public readonly agent: string) {
    super(`the conversation is too long for ${agent}'s model`);
    this.name = "ChainTooLongError";
  }
}

/**
 * Runs `runs` in order over `history` (the conversation with the new user message). `total` is the
 * chain's length with the final agent, for the "agent k of n" note.
 */
export async function runChain(session: DeviceSession, deviceId: string, conversationId: string, history: ChatMessage[], runs: ChainRun[], total: number, budget: number, hooks: ChainHooks): Promise<ChainOutcome> {
  const steps: ChainStep[] = [];
  for (const [i, run] of runs.entries()) {
    const previous = steps[i - 1];
    const system = previous ? chainSystem(run.system, i + 1, total, previous) : run.system;
    const wire = withSystem(system, toWire(history));
    const plan = planContext(
      wire.reduce((n, m) => n + m.content.length, 0),
      contextLengthOf(deviceId, run.model),
      await loadedContext(deviceId, run.model),
    );
    if (!plan.ok) throw new ChainTooLongError(run.name);
    const req: ChatRequest = { type: "chat", id: newRequestId(), conversation_id: conversationId, mode: "incognito", model: run.model, messages: wire };
    const options: ChatOptions = { ...(run.options ?? {}), ...(plan.num_ctx ? { num_ctx: plan.num_ctx } : {}) };
    if (Object.keys(options).length > 0) req.options = options;
    const think = await thinkFor(deviceId, run.model, run.think);
    if (think !== undefined) req.think = think;
    fitImagesToBudget(req, budget);

    const step: ChainStep = { agent_id: run.agent_id, name: run.name, model: run.model, content: "" };
    hooks.onRequest(req.id);
    hooks.onStep(i, step);
    const done: ChatDoneMessage = await session.stream(req, {
      onChunk: (chunk) => {
        step.content += chunk.content;
        hooks.onStep(i, { ...step });
      },
      onStalled: hooks.onStalled,
    });
    step.content = clip(step.content);
    steps.push(step);
    if (done.done_reason === "abort") return { reason: "abort", steps };
    if (done.done_reason === "error") return { reason: "error", steps };
  }
  return { reason: "stop", steps };
}

/** `think` goes only to models that advertise it (Ollama refuses it otherwise). */
async function thinkFor(deviceId: string, model: string, wanted: boolean | undefined): Promise<boolean | undefined> {
  let info = modelsStore.getState().byDevice[deviceId]?.info[model];
  if (!info) {
    await modelsStore
      .getState()
      .show(deviceId, model)
      .catch(() => null);
    info = modelsStore.getState().byDevice[deviceId]?.info[model];
  }
  return info?.capabilities?.includes("thinking") ? Boolean(wanted) : undefined;
}

/** An answer kept with the reply stays within the computer's limit (SPEC §9.4). */
function clip(content: string): string {
  const bytes = new TextEncoder().encode(content);
  if (bytes.length <= LIMITS.CHAIN_STEP_MAX_BYTES) return content;
  return new TextDecoder().decode(bytes.slice(0, LIMITS.CHAIN_STEP_MAX_BYTES - 4));
}
