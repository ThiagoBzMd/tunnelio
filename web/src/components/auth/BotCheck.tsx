// Bot check widget, only rendered when the server advertises a site key, the address of the
// widget's script and the name of the object that script defines (`window[global]`, with the usual
// render/remove interface of these widgets). Loads the script once; the token is handed to the
// parent and sent as `bot_check_token`.

import { useEffect, useRef } from "react";

import { useAuth } from "@/stores/react";

interface BotCheckApi {
  render(el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void; "expired-callback"?: () => void; theme?: "light" | "dark" | "auto" }): string;
  remove?(id: string): void;
}

function widgetApi(name: string): BotCheckApi | undefined {
  const api = (window as unknown as Record<string, unknown>)[name];
  return api && typeof (api as BotCheckApi).render === "function" ? (api as BotCheckApi) : undefined;
}

let scriptPromise: Promise<void> | null = null;

function loadScript(scriptUrl: string, name: string): Promise<void> {
  if (widgetApi(name)) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const src = new URL(scriptUrl);
    src.searchParams.set("render", "explicit"); // rendered by us below, not by class name
    const s = document.createElement("script");
    s.src = src.toString();
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("the bot check's script failed to load"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export function BotCheck({ siteKey, onToken }: { siteKey: string; onToken: (token: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const scriptUrl = useAuth((s) => s.flags.bot_check_script_url);
  const globalName = useAuth((s) => s.flags.bot_check_global);
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;
    if (!scriptUrl || !globalName) {
      onTokenRef.current(null);
      return;
    }
    loadScript(scriptUrl, globalName)
      .then(() => {
        const api = widgetApi(globalName);
        if (cancelled || !ref.current || !api) return;
        widgetId = api.render(ref.current, {
          sitekey: siteKey,
          theme: "auto",
          callback: (token) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
        });
      })
      .catch(() => onTokenRef.current(null));
    return () => {
      cancelled = true;
      if (widgetId) widgetApi(globalName)?.remove?.(widgetId);
    };
  }, [siteKey, scriptUrl, globalName]);

  return <div ref={ref} className="min-h-[65px]" data-testid="bot-check" />;
}
