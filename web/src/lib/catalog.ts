// The Ollama library as the server relays it (`GET /api/catalog/ollama`, refreshed daily): wire
// shape check, search, the names one can pull from an entry and how big each download is.

import { matchesQuery } from "./text";

export interface CatalogModel {
  name: string;
  description: string;
  /** Subset of "tools" | "vision" | "thinking" | "embedding". */
  capabilities: string[];
  /** Parameter sizes as the library lists them ("1b", "8x7b"…), also the pullable tags. */
  sizes: string[];
  pulls: number | null;
  pulls_text: string;
  tags: number | null;
  updated_at: string | null;
  updated_text: string;
  /**
   * Download size per pullable tag ("3b", "latest"), as [smallest, largest]: a range when the tag
   * has a variant per platform. A tag is missing until the server has read the model's page.
   */
  size_bytes: Readonly<Record<string, readonly [number, number]>>;
}

export interface Catalog {
  source: string;
  fetched_at: string | null;
  origin: "live" | "snapshot";
  models: CatalogModel[];
}

export const CATALOG_CAPABILITIES = ["vision", "tools", "thinking", "embedding"] as const;
export type CatalogCapability = (typeof CATALOG_CAPABILITIES)[number];

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TAG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const isStr = (v: unknown): v is string => typeof v === "string";
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isBytes = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** `{"3b": [lo, hi]}` with a sane tag and 0 < lo ≤ hi; anything else is dropped. */
function sizeMap(v: unknown): Record<string, readonly [number, number]> {
  const out: Record<string, readonly [number, number]> = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [tag, pair] of Object.entries(v)) {
    if (!TAG_RE.test(tag) || !Array.isArray(pair) || pair.length !== 2) continue;
    const [lo, hi] = pair as unknown[];
    if (isBytes(lo) && isBytes(hi) && lo <= hi) out[tag] = [lo, hi];
  }
  return out;
}

/**
 * Strict enough to never render junk: entries without a valid name are dropped, the rest
 * defaults. Only what can be pulled to the computer is kept: entries that exist solely on
 * Ollama's cloud (the "cloud" tag with no local size) are dropped, and the cloud tag itself is
 * not shown on the others.
 */
export function parseCatalog(v: unknown): Catalog | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.models)) return null;
  const models: CatalogModel[] = [];
  for (const raw of o.models) {
    if (typeof raw !== "object" || raw === null) continue;
    const m = raw as Record<string, unknown>;
    if (!isStr(m.name) || !NAME_RE.test(m.name)) continue;
    const allCaps = strList(m.capabilities);
    const sizes = strList(m.sizes);
    if (allCaps.includes("cloud") && sizes.length === 0) continue;
    models.push({
      name: m.name,
      description: isStr(m.description) ? m.description : "",
      capabilities: allCaps.filter((c) => c !== "cloud"),
      sizes,
      pulls: numOrNull(m.pulls),
      pulls_text: isStr(m.pulls_text) ? m.pulls_text : "",
      tags: numOrNull(m.tags),
      updated_at: isStr(m.updated_at) ? m.updated_at : null,
      updated_text: isStr(m.updated_text) ? m.updated_text : "",
      size_bytes: sizeMap(m.size_bytes),
    });
  }
  return {
    source: isStr(o.source) ? o.source : "",
    fetched_at: isStr(o.fetched_at) ? o.fetched_at : null,
    origin: o.origin === "live" ? "live" : "snapshot",
    models,
  };
}

/** Name or description match (accent-insensitive) and every selected capability present. */
export function searchCatalog(models: readonly CatalogModel[], query: string, capabilities: readonly string[] = []): CatalogModel[] {
  return models.filter((m) => capabilities.every((c) => m.capabilities.includes(c)) && (matchesQuery(m.name, query) || matchesQuery(m.description, query)));
}

/** "llama3.2" with sizes ["1b","3b"] → ["llama3.2:1b","llama3.2:3b"]; no sizes → ["llama3.2:latest"]. */
export function pullTargets(m: CatalogModel): string[] {
  return m.sizes.length > 0 ? m.sizes.map((s) => `${m.name}:${s}`) : [`${m.name}:latest`];
}

/**
 * What one click in "Other models" downloads: the size Ollama recommends (its "latest" tag), or
 * the first size for a model whose page shows no "latest" (e.g. granite4.1: 3b, 8b, 30b only).
 */
export function quickTarget(m: CatalogModel): string {
  const pageRead = Object.keys(m.size_bytes).length > 0;
  const first = m.sizes[0];
  return `${m.name}:${pageRead && !Object.hasOwn(m.size_bytes, "latest") && first ? first : "latest"}`;
}

/** How big pulling `tag` of an entry is ("3b", "latest"), when the server knows it. */
export function downloadSize(m: CatalogModel, tag: string): readonly [number, number] | undefined {
  return Object.hasOwn(m.size_bytes, tag) ? m.size_bytes[tag] : undefined;
}

/** The library entry an installed model came from ("ns/llama3.2:3b" → "llama3.2"), when known. */
export function catalogEntryFor(models: readonly CatalogModel[], installedName: string): CatalogModel | undefined {
  const family = (installedName.split(":")[0] ?? "").split("/").pop()?.toLowerCase() ?? "";
  return models.find((m) => m.name === family);
}
