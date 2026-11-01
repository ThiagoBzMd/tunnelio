// Text helpers shared by the sidebar search and the model catalog.

/** Lower-case without diacritics ("Cálculo" → "calculo"). */
export const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

/** Case- and accent-insensitive match: every word of the query must appear in the text. */
export function matchesQuery(text: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold(text);
  return words.every((w) => hay.includes(w));
}
