// The Ollama library as relayed by the server: wire check, search, pull targets, download sizes.

import { describe, expect, it } from "vitest";
import { catalogEntryFor, downloadSize, parseCatalog, pullTargets, quickTarget, searchCatalog, type CatalogModel } from "../src/lib/catalog";

const wire = {
  source: "https://ollama.com/library?sort=popular",
  fetched_at: "2026-10-14T01:00:00+00:00",
  origin: "live",
  models: [
    {
      name: "llama3.2",
      description: "Meta's Llama 3.2 goes small",
      capabilities: ["tools"],
      sizes: ["1b", "3b"],
      pulls: 1000,
      pulls_text: "1K",
      tags: 3,
      updated_at: null,
      updated_text: "1 year ago",
      // As JSON.parse leaves it: "__proto__" is an own key there.
      size_bytes: JSON.parse('{"1b": [1.3e9, 1.3e9], "3b": [2e9, 2e9], "latest": [2e9, 2e9], "__proto__": [1, 1], "8b": [9e9, 4e9], "70b": [-1, 1], "bad": "x", "405b": [1, 2, 3]}') as unknown,
    },
    { name: "moondream", description: "A small vision language model", capabilities: ["vision"], sizes: [], pulls: null, pulls_text: "", tags: null, updated_at: null, updated_text: "" },
    { name: "Bad Name", description: "x" },
    "junk",
    { name: "qwen3", description: "Qwen3 reasons", capabilities: ["tools", "thinking"], sizes: ["0.6b", "8b"] },
    { name: "gpt-oss", description: "cloud only", capabilities: ["tools", "cloud"], sizes: [] },
    { name: "gemma4", description: "local and cloud", capabilities: ["vision", "cloud"], sizes: ["31b"] },
  ],
};

describe("catalog", () => {
  it("checks the wire shape and defaults the optional fields", () => {
    const c = parseCatalog(wire);
    expect(c?.origin).toBe("live");
    // Cloud-only entries cannot be pulled to the computer: dropped; the cloud tag is not shown on the others.
    expect(c?.models.map((m) => m.name)).toEqual(["llama3.2", "moondream", "qwen3", "gemma4"]);
    expect(c?.models[3]?.capabilities).toEqual(["vision"]);
    expect(c?.models[2]).toMatchObject({ pulls: null, pulls_text: "", tags: null, updated_at: null, updated_text: "" });
    expect(parseCatalog({ models: "no" })).toBeNull();
    expect(parseCatalog(null)).toBeNull();
    expect(parseCatalog({ models: [] })?.origin).toBe("snapshot");
  });

  it("searches name and description, accent-insensitive, and filters by capability", () => {
    const models = parseCatalog(wire)?.models as CatalogModel[];
    expect(searchCatalog(models, "LLAMA").map((m) => m.name)).toEqual(["llama3.2"]);
    expect(searchCatalog(models, "visão language").map((m) => m.name)).toEqual([]);
    expect(searchCatalog(models, "vision").map((m) => m.name)).toEqual(["moondream"]);
    expect(searchCatalog(models, "", ["vision"]).map((m) => m.name)).toEqual(["moondream", "gemma4"]);
    expect(searchCatalog(models, "", ["tools"]).map((m) => m.name)).toEqual(["llama3.2", "qwen3"]);
    expect(searchCatalog(models, "", ["tools", "thinking"]).map((m) => m.name)).toEqual(["qwen3"]);
    expect(searchCatalog(models, "").length).toBe(4);
  });

  it("lists what can be pulled from an entry", () => {
    const models = parseCatalog(wire)?.models as CatalogModel[];
    expect(pullTargets(models[0] as CatalogModel)).toEqual(["llama3.2:1b", "llama3.2:3b"]);
    expect(pullTargets(models[1] as CatalogModel)).toEqual(["moondream:latest"]);
    expect(catalogEntryFor(models, "ns/llama3.2:3b")?.name).toBe("llama3.2");
    expect(catalogEntryFor(models, "gemma4:31b")?.name).toBe("gemma4");
    expect(catalogEntryFor(models, "mistral:7b")).toBeUndefined();
  });

  it("keeps the download sizes it can trust, per tag", () => {
    const [llama, moondream] = parseCatalog(wire)?.models as CatalogModel[];
    // Only a sane tag with 0 < smallest ≤ largest.
    expect(llama?.size_bytes).toEqual({ "1b": [1.3e9, 1.3e9], "3b": [2e9, 2e9], latest: [2e9, 2e9] });
    expect(downloadSize(llama as CatalogModel, "3b")).toEqual([2e9, 2e9]);
    expect(downloadSize(llama as CatalogModel, "8b")).toBeUndefined();
    expect(downloadSize(llama as CatalogModel, "constructor")).toBeUndefined();
    expect(moondream?.size_bytes).toEqual({});
  });

  it("downloads in one click the tag Ollama recommends, or the first size when there is none", () => {
    const [llama, moondream] = parseCatalog(wire)?.models as CatalogModel[];
    expect(quickTarget(llama as CatalogModel)).toBe("llama3.2:latest");
    expect(quickTarget(moondream as CatalogModel)).toBe("moondream:latest"); // page not read yet
    const granite = parseCatalog({ models: [{ name: "granite4.1", sizes: ["3b", "8b"], size_bytes: { "3b": [2.1e9, 2.1e9], "8b": [5.3e9, 5.3e9] } }] })?.models[0];
    expect(quickTarget(granite as CatalogModel)).toBe("granite4.1:3b");
  });
});
