// The dictionaries of @zxcvbn-ts/language-* imported one by one (lib/strength.ts), so the screens
// that set a password load only the lists they use.
declare module "@zxcvbn-ts/language-en/dist/*.json.mjs" {
  const words: string[];
  export default words;
}
declare module "@zxcvbn-ts/language-pt-br/dist/*.json.mjs" {
  const words: string[];
  export default words;
}
declare module "@zxcvbn-ts/language-en/dist/wordSequences.json.mjs" {
  const sequences: Record<string, string[]>;
  export default sequences;
}
declare module "@zxcvbn-ts/language-pt-br/dist/wordSequences.json.mjs" {
  const sequences: Record<string, string[]>;
  export default sequences;
}
