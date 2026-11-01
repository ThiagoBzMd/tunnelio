// Model memory (SPEC §7.7). Ollama picks the context when it loads a model (by the computer's video
// memory: 4k, 32k or 256k, or the Ollama app's setting) and never grows it during a conversation:
// what does not fit is cut from the start, silently. Changing it reloads the model. So:
//   estimate = ceil(chars / 3.5) of the whole conversation being sent + 2048 reserved for the answer
//   estimate > model max                    → sending is blocked
//   the model is loaded with L ≥ estimate   → num_ctx = L: Ollama's own choice, no reload
//   not loaded and estimate ≤ 4096          → nothing: Ollama's choice, never below 4k
//   otherwise                               → num_ctx = the power of two ≥ estimate (8k, 16k, 32k…),
//                                             capped at the model's max: one reload, rarely another
//   model max unknown                       → nothing (as before rev. 1.4)
// The answer reserve is capped at a quarter of the model's maximum: with the full 2048, a model
// whose whole memory is 2048 tokens (e.g. moondream) could never be sent anything. Models with
// 8192 tokens or more get exactly the rule above.

export const CHARS_PER_TOKEN = 3.5;
export const ANSWER_RESERVE_TOKENS = 2048;
export const DEFAULT_CONTEXT_TOKENS = 4096;

export function answerReserve(modelMax: number | null | undefined): number {
  return modelMax && modelMax > 0 ? Math.min(ANSWER_RESERVE_TOKENS, Math.floor(modelMax / 4)) : ANSWER_RESERVE_TOKENS;
}

export function estimateTokens(chars: number, reserve: number = ANSWER_RESERVE_TOKENS): number {
  return Math.ceil(chars / CHARS_PER_TOKEN) + reserve;
}

export type ContextPlan = { ok: true; num_ctx?: number; estimate: number } | { ok: false; reason: "too_long"; estimate: number; max: number };

/**
 * `modelMax` = `context_length` from show_model; `loaded` = the context the model is loaded with
 * right now (list_running), when known. `null`/`undefined` when not known.
 */
export function planContext(chars: number, modelMax: number | null | undefined, loaded?: number | null): ContextPlan {
  const estimate = estimateTokens(chars, answerReserve(modelMax));
  if (!modelMax || !Number.isFinite(modelMax) || modelMax <= 0) return { ok: true, estimate };
  if (estimate > modelMax) return { ok: false, reason: "too_long", estimate, max: modelMax };
  if (loaded && loaded > 0 && estimate <= loaded) return { ok: true, estimate, num_ctx: loaded };
  if (!loaded && estimate <= DEFAULT_CONTEXT_TOKENS) return { ok: true, estimate };
  return { ok: true, estimate, num_ctx: Math.min(modelMax, 2 ** Math.ceil(Math.log2(estimate))) };
}
