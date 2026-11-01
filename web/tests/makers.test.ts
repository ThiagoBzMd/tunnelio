// Model name → maker (logo) table.

import { describe, expect, it } from "vitest";
import { familyOf, makerOf } from "../src/lib/makers";

describe("makers", () => {
  it("takes the library family from a full name", () => {
    expect(familyOf("llama3.2:3b")).toBe("llama3.2");
    expect(familyOf("ns/llama3.2:3b")).toBe("llama3.2");
    expect(familyOf("Gemma4:latest")).toBe("gemma4");
    expect(familyOf("")).toBe("");
  });

  it("maps known families to their makers, derivatives first", () => {
    const cases: [string, string | null][] = [
      ["llama3.2:3b", "meta"],
      ["codellama:7b", "meta"],
      ["medgemma:27b", "google"],
      ["gemma4:31b", "google"],
      ["qwen2.5:0.5b", "alibaba"],
      ["qwq", "alibaba"],
      ["deepseek-r1:7b", "deepseek"],
      ["mistral-nemo", "mistral"],
      ["phi4-mini", "microsoft"],
      ["gpt-oss:20b", "openai"],
      ["command-r7b", "cohere"],
      ["granite3.1-moe", "ibm"],
      ["nemotron-mini", "nvidia"],
      ["llama3-chatqa", "nvidia"],
      ["smollm2", "huggingface"],
      ["glm4", "zhipu"],
      ["kimi-k2", "moonshot"],
      ["falcon3", "tii"],
      ["olmo2", "ai2"],
      ["dolphin-llama3", "dolphin"],
      ["nous-hermes2", "nous"],
      ["yi-coder", "01ai"],
      ["moondream:latest", null],
      ["llava", null],
      ["nomic-embed-text", null],
      ["", null],
    ];
    for (const [name, maker] of cases) expect(makerOf(name)?.id ?? null, name).toBe(maker);
  });

  it("every maker has a name and a logo", () => {
    for (const name of ["llama3", "gemma3", "qwen3", "deepseek-v3", "mistral", "phi3", "gpt-oss", "command-a", "granite4", "nemotron", "glm-4.6", "falcon2", "stablelm2", "solar-pro", "exaone3.5", "lfm2", "bge-m3", "snowflake-arctic-embed", "internlm2", "minimax-m2", "grok-3"]) {
      const m = makerOf(name);
      expect(m, name).not.toBeNull();
      expect(m?.name.length).toBeGreaterThan(1);
      expect(typeof m?.icon).toBe("string");
    }
  });
});
