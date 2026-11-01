// The Ollama library list (server relay of ollama.com/library, daily). Loaded once per session,
// cached in the browser for a day so the model menu opens instantly; a failed fetch keeps the
// cached list (stale is better than nothing) and only reports an error when there is none.

import { createStore } from "zustand/vanilla";
import { parseCatalog, type Catalog } from "../lib/catalog";
import { getRuntime } from "./runtime";
import { errorMessage } from "./util";

// rev. 1.9: a new key for the list with download sizes, so the one cached before them is not kept a day.
const CACHE_KEY = "catalog:ollama:2";
const OLD_CACHE_KEY = "catalog:ollama";
const CACHE_TTL_MS = 24 * 3600_000;

interface Cached {
  saved_at: number;
  catalog: Catalog;
}

export interface CatalogState {
  catalog: Catalog | null;
  loading: boolean;
  error: string | null;
  /** Loads from the browser cache when fresh, else from the server. `force` skips the cache. */
  load(force?: boolean): Promise<Catalog | null>;
  reset(): void;
}

function readCache(v: unknown, now: number): Cached | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.saved_at !== "number" || o.saved_at > now) return null;
  const catalog = parseCatalog(o.catalog);
  return catalog && catalog.models.length > 0 ? { saved_at: o.saved_at, catalog } : null;
}

export const catalogStore = createStore<CatalogState>((set, get) => {
  let inflight: Promise<Catalog | null> | null = null;
  return {
    catalog: null,
    loading: false,
    error: null,

    load: (force = false) => {
      if (inflight) return inflight;
      inflight = (async () => {
        const { api, storage } = getRuntime();
        const now = Date.now();
        let cached: Cached | null = null;
        try {
          cached = readCache(await storage.settings.get(CACHE_KEY), now);
          void storage.settings.delete(OLD_CACHE_KEY).catch(() => undefined);
        } catch {
          /* storage unavailable */
        }
        if (cached && !get().catalog) set({ catalog: cached.catalog });
        if (cached && !force && now - cached.saved_at < CACHE_TTL_MS) return cached.catalog;
        set({ loading: true, error: null });
        try {
          const catalog = parseCatalog(await api.ollamaCatalog());
          if (!catalog || catalog.models.length === 0) throw new Error("empty catalog");
          set({ catalog, loading: false });
          await storage.settings.set(CACHE_KEY, { saved_at: now, catalog } satisfies Cached).catch(() => undefined);
          return catalog;
        } catch (e) {
          set({ loading: false, error: get().catalog ? null : errorMessage(e) });
          return get().catalog;
        }
      })().finally(() => {
        inflight = null;
      });
      return inflight;
    },

    reset: () => set({ catalog: null, loading: false, error: null }),
  };
});
