// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  Dictation,
  getRecognizerCtor,
  isSupported,
  joinWithSpace,
  mergeResults,
  speechLang,
  type RecognizerLike,
  type SpeechResultEventLike,
} from "../src/lib/speech";

function result(transcript: string, isFinal: boolean) {
  return { isFinal, 0: { transcript } };
}

describe("speech: result merging", () => {
  it("joins with a single space and trims the edges", () => {
    expect(joinWithSpace("", "olá")).toBe("olá");
    expect(joinWithSpace("olá ", " mundo ")).toBe("olá mundo");
    expect(joinWithSpace("olá", "")).toBe("olá");
    expect(joinWithSpace("a\n", "b")).toBe("a b");
  });

  it("separates newly final text from the interim guess, walking from resultIndex", () => {
    // Cumulative list as real engines report it: result 0 was finalised earlier (resultIndex=1).
    const e: SpeechResultEventLike = { resultIndex: 1, results: [result("olá", true), result("mun", false)] };
    expect(mergeResults(e)).toEqual({ finalDelta: "", interim: "mun" });
    const e2: SpeechResultEventLike = { resultIndex: 1, results: [result("olá", true), result("mundo", true), result("tudo", false)] };
    expect(mergeResults(e2)).toEqual({ finalDelta: "mundo", interim: "tudo" });
  });

  it("also works for engines/fakes that only send the changed entry with resultIndex 0", () => {
    expect(mergeResults({ resultIndex: 0, results: [result("olá", false)] })).toEqual({ finalDelta: "", interim: "olá" });
    expect(mergeResults({ resultIndex: 0, results: [result("olá mundo", true)] })).toEqual({ finalDelta: "olá mundo", interim: "" });
    expect(mergeResults({ resultIndex: 0, results: [result("  ", false)] })).toEqual({ finalDelta: "", interim: "" });
    expect(mergeResults({ resultIndex: -3, results: [result("x", true)] })).toEqual({ finalDelta: "x", interim: "" });
  });

  it("maps the app language to the engine tag and detects support", () => {
    expect(speechLang("pt-BR")).toBe("pt-BR");
    expect(speechLang("en")).toBe("en-US");
    expect(isSupported({})).toBe(false);
    expect(isSupported({ webkitSpeechRecognition: class {} })).toBe(true);
    expect(getRecognizerCtor({ SpeechRecognition: class {} })).not.toBeNull();
  });
});

describe("speech: Dictation wrapper against a fake recognizer", () => {
  class FakeRecognizer implements RecognizerLike {
    static instances: FakeRecognizer[] = [];
    continuous = false;
    interimResults = false;
    lang = "";
    onresult: ((e: SpeechResultEventLike) => void) | null = null;
    onerror: ((e: { error: string; message?: string }) => void) | null = null;
    onend: (() => void) | null = null;
    started = 0;
    stopped = 0;
    aborted = 0;
    constructor() {
      FakeRecognizer.instances.push(this);
    }
    start() {
      this.started += 1;
    }
    stop() {
      this.stopped += 1;
      this.onend?.();
    }
    abort() {
      this.aborted += 1;
    }
  }

  it("accumulates final text across events, replaces interim text, commits on end", () => {
    FakeRecognizer.instances = [];
    const d = new Dictation(FakeRecognizer);
    const log: [string, string][] = [];
    let ended = 0;
    const errors: string[] = [];
    expect(d.supported).toBe(true);
    expect(d.start("pt-BR", { onResult: (f, i) => log.push([f, i]), onEnd: () => (ended += 1), onError: (c) => errors.push(c) })).toBe(true);
    const rec = FakeRecognizer.instances[0]!;
    expect(rec).toMatchObject({ continuous: true, interimResults: true, lang: "pt-BR", started: 1 });
    expect(d.listening).toBe(true);
    expect(d.start("en-US", { onResult: () => undefined, onEnd: () => undefined, onError: () => undefined })).toBe(true); // no-op while listening
    expect(FakeRecognizer.instances).toHaveLength(1);

    // The composer appends every finalDelta and shows the latest interim; this is the sequence it sees.
    rec.onresult?.({ resultIndex: 0, results: [result("olá", false)] });
    rec.onresult?.({ resultIndex: 0, results: [result("olá mundo", true)] });
    rec.onresult?.({ resultIndex: 1, results: [result("olá mundo", true), result("tudo", false)] });
    rec.onresult?.({ resultIndex: 1, results: [result("olá mundo", true), result("tudo bem", true)] });
    expect(log).toEqual([
      ["", "olá"],
      ["olá mundo", ""],
      ["", "tudo"],
      ["tudo bem", ""],
    ]);
    let committed = "";
    for (const [f] of log) committed = joinWithSpace(committed, f);
    expect(committed).toBe("olá mundo tudo bem");

    rec.onerror?.({ error: "no-speech" });
    expect(errors).toEqual(["no-speech"]);
    d.stop();
    expect(rec.stopped).toBe(1);
    expect(ended).toBe(1);
    expect(d.listening).toBe(false);
    d.stop(); // idempotent
    expect(rec.stopped).toBe(1);
  });

  it("abort drops the recognizer immediately and reports unsupported engines", () => {
    FakeRecognizer.instances = [];
    const d = new Dictation(FakeRecognizer);
    d.start("en-US", { onResult: () => undefined, onEnd: () => undefined, onError: () => undefined });
    d.abort();
    expect(FakeRecognizer.instances[0]?.aborted).toBe(1);
    expect(d.listening).toBe(false);
    const none = new Dictation(null);
    expect(none.supported).toBe(false);
    expect(none.start("en-US", { onResult: () => undefined, onEnd: () => undefined, onError: () => undefined })).toBe(false);
    class Refusing extends FakeRecognizer {
      override start() {
        throw new Error("InvalidStateError");
      }
    }
    const r = new Dictation(Refusing);
    expect(r.start("en-US", { onResult: () => undefined, onEnd: () => undefined, onError: () => undefined })).toBe(false);
    expect(r.listening).toBe(false);
  });
});
