// Password strength: how hard a password is to guess, with zxcvbn-ts (leaked and
// common passwords, English and Brazilian Portuguese words and names, keyboard patterns, dates,
// repeats). The server only ever sees a key derived from the password, so a copy of its database
// can be attacked offline: a new password must reach MIN_STRENGTH. The dictionaries are large
// (~600 KB compressed): loaded only by the screens that set a password.

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

/** zxcvbn's "safely unguessable": good against offline guessing of a slow hash (≥ 10^8 guesses). */
export const MIN_STRENGTH: StrengthScore = 3;

export type StrengthCheck = (password: string, hints: readonly string[]) => StrengthScore;

let loading: Promise<StrengthCheck> | null = null;

/** Loads the checker once (the dictionaries come with it). */
export function loadStrength(): Promise<StrengthCheck> {
  loading ??= (async () => {
    const [{ ZxcvbnFactory }, common, enWords, enNames, enSequences, ptWords, ptNames, ptSurnames, ptSequences] = await Promise.all([
      import("@zxcvbn-ts/core"),
      import("@zxcvbn-ts/language-common"),
      import("@zxcvbn-ts/language-en/dist/commonWords.json.mjs"),
      import("@zxcvbn-ts/language-en/dist/firstnames.json.mjs"),
      import("@zxcvbn-ts/language-en/dist/wordSequences.json.mjs"),
      import("@zxcvbn-ts/language-pt-br/dist/commonWords.json.mjs"),
      import("@zxcvbn-ts/language-pt-br/dist/firstnames.json.mjs"),
      import("@zxcvbn-ts/language-pt-br/dist/lastnames.json.mjs"),
      import("@zxcvbn-ts/language-pt-br/dist/wordSequences.json.mjs"),
    ]);
    const zxcvbn = new ZxcvbnFactory({
      graphs: common.adjacencyGraphs,
      dictionary: {
        ...common.dictionary,
        "commonWords-en": enWords.default,
        "firstnames-en": enNames.default,
        ...enSequences.default,
        "commonWords-pt-br": ptWords.default,
        "firstnames-pt-br": ptNames.default,
        "lastnames-pt-br": ptSurnames.default,
        ...ptSequences.default,
      },
    });
    return (password, hints) => zxcvbn.check(password.normalize("NFC"), [...hints]).score as StrengthScore;
  })();
  loading.catch(() => {
    loading = null; // a failed download is tried again next time
  });
  return loading;
}

/** What the person typed about themselves, so a password made of it scores low (e-mail, its name part). */
export function strengthHints(email: string): string[] {
  const e = email.trim().toLowerCase();
  if (!e) return [];
  const local = e.split("@")[0] ?? "";
  return [e, local, ...local.split(/[._+-]+/).filter((w) => w.length > 2)];
}

/** True when the password is below MIN_STRENGTH; false when the checker cannot load (the length and common-password rules still hold). */
export async function tooWeak(password: string, hints: readonly string[]): Promise<boolean> {
  try {
    return (await loadStrength())(password, hints) < MIN_STRENGTH;
  } catch {
    return false;
  }
}
