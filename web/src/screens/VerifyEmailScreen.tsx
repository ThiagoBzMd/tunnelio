// Confirm the e-mail (rev. 1.3): the 6-digit code mailed at sign-up (or asked for again at sign-in when
// the account is still unconfirmed). Confirming signs the browser in.

import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { afterLogin } from "@/app/bootstrap";
import { AuthLayout, FormError } from "@/components/auth/AuthLayout";
import { BotCheck } from "@/components/auth/BotCheck";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n";
import { authStore } from "@/stores/auth";
import { useAuth } from "@/stores/react";

const RESEND_COOLDOWN_S = 60;

export function VerifyEmailScreen() {
  const { t } = useT();
  const loc = useLocation();
  const busy = useAuth((s) => s.busy);
  const error = useAuth((s) => s.error);
  const errorCode = useAuth((s) => s.errorCode);
  const email = useAuth((s) => s.pendingVerification);
  const siteKey = useAuth((s) => s.flags.bot_check_site_key);
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_S);
  const [botCheckToken, setBotCheckToken] = useState<string | null>(null);
  const [botCheckKey, setBotCheckKey] = useState(0);

  useEffect(() => () => authStore.getState().clearError(), []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  if (!email) return <Navigate to="/register" replace state={loc.state} />;
  const needsBotCheck = Boolean(siteKey) && !botCheckToken;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return;
    if (await authStore.getState().verifyEmail(email, code)) await afterLogin();
  };

  const resend = async () => {
    if (cooldown > 0 || needsBotCheck) return;
    const token = botCheckToken ?? undefined;
    setBotCheckToken(null);
    setBotCheckKey((k) => k + 1);
    if (await authStore.getState().resendCode(email, token)) {
      toast.success(t("auth.codeResent"));
      setCooldown(RESEND_COOLDOWN_S);
    }
  };

  const shownError = errorCode === "E_BAD_CODE" ? t("auth.badCode") : error;

  return (
    <AuthLayout
      title={t("auth.verifyTitle")}
      subtitle={t("auth.verifySubtitle", { email })}
      footer={
        <Link to="/login" className="underline-offset-4 hover:underline" data-testid="link-login">
          {t("auth.backToLogin")}
        </Link>
      }
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4" data-testid="verify-form">
        <div className="space-y-1.5">
          <Label htmlFor="code">{t("auth.codeLabel")}</Label>
          <Input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="h-12 text-center font-mono text-xl tracking-[0.4em]"
            data-testid="verify-code"
          />
          <p className="text-xs text-muted-foreground">{t("auth.codeHint")}</p>
        </div>
        <FormError message={shownError} />
        <Button type="submit" className="w-full" disabled={busy || code.length !== 6} data-testid="submit">
          {busy ? <Loader2Icon className="animate-spin" /> : null}
          {t("auth.verify")}
        </Button>
        {siteKey && cooldown === 0 ? <BotCheck key={botCheckKey} siteKey={siteKey} onToken={setBotCheckToken} /> : null}
        <div className="flex items-center justify-between gap-3 text-sm">
          <button type="button" className="text-muted-foreground underline-offset-4 hover:underline disabled:no-underline disabled:opacity-60" onClick={() => void resend()} disabled={cooldown > 0 || busy || needsBotCheck} data-testid="resend-code">
            {cooldown > 0 ? t("auth.resendIn", { s: cooldown }) : t("auth.resendCode")}
          </button>
          <Link to="/register" className="text-muted-foreground underline-offset-4 hover:underline" data-testid="other-email">
            {t("auth.otherEmail")}
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}
