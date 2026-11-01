// Lightweight i18n: two flat dictionaries (en, pt-BR), browser detection, language persisted in the
// settings store. Every user-facing string goes through `t()` / `useT()`.

import { useCallback } from "react";
import { useSettings } from "../stores/react";
import { settingsStore, type Language } from "../stores/settings";
import { en, type TKey } from "./en";
import { ptBR } from "./pt-BR";

export type { TKey } from "./en";
export type { Language } from "../stores/settings";

export const LANGUAGES: readonly Language[] = ["en", "pt-BR"] as const;

const dicts: Record<Language, Record<TKey, string>> = { en, "pt-BR": ptBR };

export type TVars = Record<string, string | number>;

export function detectLanguage(): Language {
  const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
  const tag = (nav?.languages?.[0] ?? nav?.language ?? "en").toLowerCase();
  return tag.startsWith("pt") ? "pt-BR" : "en";
}

export function currentLanguage(): Language {
  return settingsStore.getState().settings.language ?? detectLanguage();
}

export function translate(lang: Language, key: TKey, vars?: TVars): string {
  let s: string = dicts[lang][key] ?? en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

/** Non-hook access (toasts, store-driven messages). */
export function t(key: TKey, vars?: TVars): string {
  return translate(currentLanguage(), key, vars);
}

export function useT(): { t: (key: TKey, vars?: TVars) => string; lang: Language } {
  const stored = useSettings((s) => s.settings.language);
  const lang = stored ?? detectLanguage();
  const tt = useCallback((key: TKey, vars?: TVars) => translate(lang, key, vars), [lang]);
  return { t: tt, lang };
}

/** BCP-47 locale for Intl APIs. */
export function localeOf(lang: Language): string {
  return lang === "pt-BR" ? "pt-BR" : "en-US";
}
