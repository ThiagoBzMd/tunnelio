// Per-model generation settings the user may set (SPEC §8.3 ranges; the tray rejects anything
// else). Kept in the browser per model name; an empty field means "the model's own default", and
// a model without any field set sends no `options` beyond the memory rule (`num_ctx`).

import type { ChatOptions } from "../protocol/channel";

export type ModelOptionKey = "temperature" | "top_p" | "top_k" | "num_predict" | "repeat_penalty" | "seed";

export type ModelOptions = Pick<ChatOptions, ModelOptionKey>;

export interface ModelOptionField {
  key: ModelOptionKey;
  min: number;
  max: number;
  step: number;
  integer: boolean;
}

export const MODEL_OPTION_FIELDS: readonly ModelOptionField[] = [
  { key: "temperature", min: 0, max: 2, step: 0.1, integer: false },
  { key: "top_p", min: 0, max: 1, step: 0.05, integer: false },
  { key: "top_k", min: 1, max: 1000, step: 1, integer: true },
  { key: "num_predict", min: -1, max: 131072, step: 1, integer: true }, // -1 = no limit; 0 is not a value
  { key: "repeat_penalty", min: 0, max: 3, step: 0.05, integer: false },
  { key: "seed", min: 0, max: 2147483647, step: 1, integer: true },
];

export function isValidOptionValue(field: ModelOptionField, value: number): boolean {
  if (!Number.isFinite(value) || value < field.min || value > field.max) return false;
  if (field.integer && !Number.isInteger(value)) return false;
  if (field.key === "num_predict" && value === 0) return false;
  return true;
}

/** Keeps only known keys with valid numbers; anything else is dropped (never rejected). */
export function sanitizeModelOptions(v: unknown): ModelOptions {
  const out: ModelOptions = {};
  if (typeof v !== "object" || v === null) return out;
  const o = v as Record<string, unknown>;
  for (const field of MODEL_OPTION_FIELDS) {
    const value = o[field.key];
    if (typeof value === "number" && isValidOptionValue(field, value)) out[field.key] = value;
  }
  return out;
}

export function hasCustomOptions(options: ModelOptions | undefined): boolean {
  return Boolean(options && Object.keys(options).length > 0);
}

/**
 * A field's text input → `null` (empty: use the default), a number, or `"invalid"`. Accepts a
 * decimal comma; integers must be whole.
 */
export function parseOptionInput(field: ModelOptionField, text: string): number | null | "invalid" {
  const t = text.trim().replace(",", ".");
  if (t === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return "invalid";
  const value = Number(t);
  return isValidOptionValue(field, value) ? value : "invalid";
}
