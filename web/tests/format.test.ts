// Formatting helpers: download sizes and parameter counts (model quantities: the English way in every language).

import { describe, expect, it } from "vitest";
import { formatBytesRange, formatParams } from "../src/lib/format";

describe("format", () => {
  it("writes a size, or a range of them", () => {
    expect(formatBytesRange(2e9, 2e9)).toBe("2 GB");
    expect(formatBytesRange(1.3e9, 1.3e9, "pt-BR")).toBe("1,3 GB");
    expect(formatBytesRange(6.6e9, 9.5e9, "pt-BR")).toBe("6,6–9,5 GB");
    expect(formatBytesRange(8e8, 1.2e9)).toBe("800 MB–1.2 GB");
    expect(formatBytesRange(19e9, 19.001e9)).toBe("19 GB");
  });

  it("tidies Ollama's parameter count, the English way", () => {
    expect(formatParams("30.7B")).toBe("30.7B");
    expect(formatParams("494.03M")).toBe("494M");
    expect(formatParams("1.2T")).toBe("1.2T");
    expect(formatParams("9.0B")).toBe("9B");
    expect(formatParams("8x7B")).toBe("8x7B"); // not a count: as is
    expect(formatParams(undefined)).toBe("");
  });
});
