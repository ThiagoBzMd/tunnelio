// Per-model settings: SPEC §8.3 ranges, text parsing, custom detection.

import { describe, expect, it } from "vitest";
import { MODEL_OPTION_FIELDS, hasCustomOptions, parseOptionInput, sanitizeModelOptions } from "../src/lib/model-options";

const field = (key: string) => {
  const f = MODEL_OPTION_FIELDS.find((x) => x.key === key);
  if (!f) throw new Error(key);
  return f;
};

describe("model options", () => {
  it("keeps valid values and drops the rest", () => {
    expect(sanitizeModelOptions({ temperature: 0.7, top_p: 0.9, top_k: 40, num_predict: -1, repeat_penalty: 1.1, seed: 42 })).toEqual({
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      num_predict: -1,
      repeat_penalty: 1.1,
      seed: 42,
    });
    expect(sanitizeModelOptions({ temperature: 3, top_k: 1.5, num_predict: 0, seed: -1, num_ctx: 4096, stop: ["x"], junk: 1 })).toEqual({});
    expect(sanitizeModelOptions({ temperature: "0.5" })).toEqual({});
    expect(sanitizeModelOptions(null)).toEqual({});
    expect(sanitizeModelOptions("x")).toEqual({});
  });

  it("parses what the user types", () => {
    expect(parseOptionInput(field("temperature"), "0,7")).toBe(0.7);
    expect(parseOptionInput(field("temperature"), " 1 ")).toBe(1);
    expect(parseOptionInput(field("temperature"), "")).toBeNull();
    expect(parseOptionInput(field("temperature"), "2.5")).toBe("invalid");
    expect(parseOptionInput(field("temperature"), "abc")).toBe("invalid");
    expect(parseOptionInput(field("top_k"), "40.5")).toBe("invalid");
    expect(parseOptionInput(field("num_predict"), "-1")).toBe(-1);
    expect(parseOptionInput(field("num_predict"), "0")).toBe("invalid");
    expect(parseOptionInput(field("seed"), "2147483647")).toBe(2147483647);
    expect(parseOptionInput(field("seed"), "2147483648")).toBe("invalid");
  });

  it("tells custom from default", () => {
    expect(hasCustomOptions(undefined)).toBe(false);
    expect(hasCustomOptions({})).toBe(false);
    expect(hasCustomOptions({ seed: 1 })).toBe(true);
  });
});
