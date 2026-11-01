// Shown instead of the app when the page is not a secure context (plain http:// on a name other
// than localhost): the browser hides WebCrypto and drops the secure cookies, so neither the
// password nor the encrypted channel can work (a self-hosted server reached by its LAN address).

import { Logo } from "@/components/layout/Logo";
import { useT } from "@/i18n";

export function isSecureEnough(win: { isSecureContext?: boolean; crypto?: { subtle?: unknown } } = globalThis as never): boolean {
  return win.isSecureContext !== false && Boolean(win.crypto?.subtle);
}

export function InsecureContext() {
  const { t } = useT();
  const here = typeof window !== "undefined" ? window.location.host : "";
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground" data-testid="insecure-context">
      <div className="w-full max-w-md space-y-4 rounded-2xl border bg-card p-6 shadow-sm">
        <Logo variant="mark" className="size-8" />
        <h1 className="text-lg font-semibold">{t("app.insecureTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("app.insecureBody")}</p>
        <p className="rounded-lg bg-muted px-3 py-2 font-mono text-[13px] break-all">https://{here}</p>
        <p className="text-xs text-muted-foreground">{t("app.insecureHint")}</p>
      </div>
    </main>
  );
}
