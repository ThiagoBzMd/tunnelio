// Dictation through the browser's own speech engine (Web Speech API). Nothing goes through the
// relay or the device: Chrome forwards audio to Google, Safari/iOS transcribe on device, Firefox
// has no implementation (the UI hides the button). The merge logic is pure so it runs in vitest.

import type { Language } from "../stores/settings";

// Structural types: the real SpeechRecognition objects and test fakes both satisfy them.
export interface SpeechAlternativeLike {
  transcript: string;
}
export interface SpeechResultLike {
  isFinal: boolean;
  0: SpeechAlternativeLike;
}
export interface SpeechResultEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechResultLike>;
}
export interface SpeechErrorEventLike {
  error: string;
  message?: string;
}
export interface RecognizerLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechResultEventLike) => void) | null;
  onerror: ((e: SpeechErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type RecognizerCtor = new () => RecognizerLike;

export function getRecognizerCtor(g: unknown = globalThis): RecognizerCtor | null {
  const w = g as { SpeechRecognition?: RecognizerCtor; webkitSpeechRecognition?: RecognizerCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSupported(g: unknown = globalThis): boolean {
  return getRecognizerCtor(g) !== null;
}

/** BCP-47 tag the engine expects for the app language. */
export function speechLang(lang: Language): string {
  return lang === "pt-BR" ? "pt-BR" : "en-US";
}

/** `a + " " + b`, collapsing missing/blank sides. */
export function joinWithSpace(a: string, b: string): string {
  const left = a.replace(/\s+$/, "");
  const right = b.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

export interface MergedResults {
  /** Text finalized by THIS event (append it to the committed text). */
  finalDelta: string;
  /** Current interim transcript (replaces the previous interim text; may be empty). */
  interim: string;
}

/**
 * Fold one `result` event into (newly final, interim). Walks `results` from `resultIndex` — the
 * first result that changed — so a final result is delivered exactly once whether the engine
 * reports a cumulative list (real browsers) or just the changed entries (fakes).
 */
export function mergeResults(event: SpeechResultEventLike): MergedResults {
  let finalDelta = "";
  let interim = "";
  const start = Math.max(0, Math.floor(Number(event.resultIndex) || 0));
  for (let i = start; i < event.results.length; i++) {
    const r = event.results[i];
    const text = r?.[0]?.transcript ?? "";
    if (!text.trim()) continue;
    if (r?.isFinal) finalDelta = joinWithSpace(finalDelta, text);
    else interim = joinWithSpace(interim, text);
  }
  return { finalDelta, interim };
}

export interface DictationHandlers {
  /** Called on every result: `finalText` is the NEW final text (may be ""), `interimText` the live guess. */
  onResult(finalText: string, interimText: string): void;
  /** The engine stopped (after `stop()`, on silence, or after an error). */
  onEnd(): void;
  /** `not-allowed`, `no-speech`, `network`, `aborted`, … (Web Speech error codes). */
  onError(code: string, message?: string): void;
}

/** One recognizer at a time; `start()` is a no-op while listening. */
export class Dictation {
  private rec: RecognizerLike | null = null;

  constructor(private readonly ctor: RecognizerCtor | null = getRecognizerCtor()) {}

  get supported(): boolean {
    return this.ctor !== null;
  }

  get listening(): boolean {
    return this.rec !== null;
  }

  /** Returns false when unsupported or when the engine refused to start. */
  start(lang: string, handlers: DictationHandlers): boolean {
    if (!this.ctor) return false;
    if (this.rec) return true;
    const rec = new this.ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang;
    rec.onresult = (e) => {
      const m = mergeResults(e);
      handlers.onResult(m.finalDelta, m.interim);
    };
    rec.onerror = (e) => handlers.onError(e.error, e.message);
    rec.onend = () => {
      if (this.rec === rec) this.rec = null;
      handlers.onEnd();
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.rec = null;
      return false;
    }
    return true;
  }

  /** Graceful: the engine may still deliver a final result before `onEnd`. */
  stop(): void {
    const rec = this.rec;
    if (!rec) return;
    try {
      rec.stop();
    } catch {
      this.rec = null;
    }
  }

  /** Immediate: drops pending audio; `onEnd` still fires in real engines. */
  abort(): void {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    rec.onresult = null;
    try {
      rec.abort();
    } catch {
      /* already stopped */
    }
  }
}
