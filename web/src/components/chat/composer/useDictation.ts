// Dictation through the browser's own speech engine (`lib/speech`): final text is appended to the
// draft as it arrives, the live guess is shown under the box until it is final, and the one-time
// hint is recorded in the settings.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/i18n";
import { Dictation, isSupported, speechLang } from "@/lib/speech";
import { useSettings } from "@/stores/react";
import { settingsStore } from "@/stores/settings";

export interface DictationHooks {
  /** Append final text to the draft (joined with a space). */
  append(text: string): void;
  /** The engine stopped (after the button, silence or an error): focus goes back to the box. */
  onEnd(): void;
}

export function useDictation({ append, onEnd }: DictationHooks) {
  const { t, lang } = useT();
  const supported = isSupported();
  const hintSeen = useSettings((s) => s.settings.dictation_hint_seen);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [showHint, setShowHint] = useState(false);
  const interimRef = useRef("");
  const dict = useRef<Dictation | null>(null);

  const setInterimText = (v: string): void => {
    interimRef.current = v;
    setInterim(v);
  };

  const commitInterim = (): void => {
    const pendingText = interimRef.current;
    interimRef.current = "";
    setInterim("");
    if (pendingText) append(pendingText);
  };

  const start = (): void => {
    dict.current ??= new Dictation();
    const ok = dict.current.start(speechLang(lang), {
      onResult: (finalText, interimText) => {
        if (finalText) append(finalText);
        setInterimText(interimText);
      },
      onEnd: () => {
        commitInterim();
        setListening(false);
        onEnd();
      },
      onError: (code) => {
        if (code === "not-allowed" || code === "service-not-allowed") toast.error(t("chat.dictationDenied"));
        else if (code !== "no-speech" && code !== "aborted") toast.error(t("chat.dictationError", { code }));
      },
    });
    if (!ok) {
      toast.error(t("chat.dictationError", { code: "unavailable" }));
      return;
    }
    setListening(true);
    if (!hintSeen) {
      setShowHint(true);
      void settingsStore.getState().update({ dictation_hint_seen: true });
    }
  };

  const toggle = (): void => {
    if (listening) dict.current?.stop();
    else start();
  };

  /** Before sending: stop the engine at once and hand over the live guess (it goes with the text). */
  const takeInterim = (): string => {
    const pendingText = interimRef.current;
    if (listening) dict.current?.abort();
    interimRef.current = "";
    setInterim("");
    setListening(false);
    return pendingText;
  };

  useEffect(() => {
    const d = dict;
    return () => d.current?.abort();
  }, []);

  return { supported, listening, interim, showHint, toggle, takeInterim };
}
