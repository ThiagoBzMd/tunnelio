// Forgot password (rev. 1.3): e-mail → 6-digit code → new password, then a normal sign-in with the new
// password. The reset disconnects every computer of the account (the trays forget their pairings),
// so the user lands on the devices screen to pair again. Shown only when the server can send
// e-mail (`flags.email_enabled`). The bot check, when enabled, guards each code request.

import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { afterLogin } from "@/app/bootstrap";
import { AuthLayout, FormError } from "@/components/auth/AuthLayout";
import { BotCheck } from "@/components/auth/BotCheck";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n";
import { MIN_PASSWORD_LENGTH, checkPassword } from "@/lib/password";
import { strengthHints, tooWeak } from "@/lib/strength";
import { PasswordStrength, usePasswordScore } from "@/components/auth/PasswordStrength";
import { authStore } from "@/stores/auth";
import { useAuth } from "@/stores/react";

const RESEND_COOLDOWN_S = 60;

export function ForgotPasswordScreen() {
  const { t } = useT();
  const navigate = useNavigate();
  const busy = useAuth((s) => s.busy);
  const error = useAuth((s) => s.error);
  const errorCode = useAuth((s) => s.errorCode);
  const emailEnabled = useAuth((s) => s.flags.email_enabled);
  const siteKey = useAuth((s) => s.flags.bot_check_site_key);
  const [step, setStep] = useState<"email" | "code">("email");
  // Each bot-check token is single-use: the widget is re-rendered (keyed) after every request.
  const [botCheckToken, setBotCheckToken] = useState<string | null>(null);
  const [botCheckKey, setBotCheckKey] = useState(0);
  const needsBotCheck = Boolean(siteKey) && !botCheckToken;
  const takeToken = () => {
    const token = botCheckToken ?? undefined;
    setBotCheckToken(null);
    setBotCheckKey((k) => k + 1);
    return token;
  };
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const score = usePasswordScore(password, strengthHints(email));
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => () => authStore.getState().clearError(), []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const sendCode = async (e: FormEvent) => {
    e.preventDefault();
    if (await authStore.getState().requestPasswordReset(email.trim(), takeToken())) {
      setStep("code");
      setCooldown(RESEND_COOLDOWN_S);
    }
  };

  const resend = async () => {
    if (cooldown > 0 || needsBotCheck) return;
    if (await authStore.getState().requestPasswordReset(email.trim(), takeToken())) {
      toast.success(t("auth.codeResent"));
      setCooldown(RESEND_COOLDOWN_S);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    authStore.getState().clearError();
    if (!/^\d{6}$/.test(code)) return setLocalError(t("auth.badCode"));
    const problem = checkPassword(password);
    if (problem === "short") return setLocalError(t("auth.passwordTooShort", { n: MIN_PASSWORD_LENGTH }));
    if (problem === "common") return setLocalError(t("auth.passwordCommon"));
    if (await tooWeak(password, strengthHints(email))) return setLocalError(t("auth.passwordWeak"));
    if (password !== confirm) return setLocalError(t("auth.passwordMismatch"));
    const address = email.trim();
    if (!(await authStore.getState().confirmPasswordReset(address, code, password))) return;
    // Every session was signed out by the reset: sign in with the new password and go pair the
    // computer again. If that sign-in fails (e.g. rate limit), the login screen takes over with the
    // e-mail filled in.
    if (await authStore.getState().login(address, password)) {
      await afterLogin();
      navigate("/devices", { replace: true });
      return;
    }
    navigate("/login", { replace: true, state: { email: address, notice: "reset" } });
  };

  const shownError = localError ?? (errorCode === "E_BAD_CODE" ? t("auth.badCode") : error);

  return (
    <AuthLayout
      title={t("auth.forgotTitle")}
      subtitle={emailEnabled ? (step === "email" ? t("auth.forgotSubtitle") : t("auth.codeSent", { email: email.trim() })) : undefined}
      footer={
        <Link to="/login" className="underline-offset-4 hover:underline">
          {t("auth.backToLogin")}
        </Link>
      }
    >
      {!emailEnabled ? (
        <p className="text-sm text-muted-foreground" data-testid="reset-unavailable">
          {t("auth.resetUnavailable")}
        </p>
      ) : step === "email" ? (
        <form onSubmit={(e) => void sendCode(e)} className="space-y-4" data-testid="forgot-email-form">
          <div className="space-y-1.5">
            <Label htmlFor="email">{t("auth.email")}</Label>
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} data-testid="email" />
          </div>
          {siteKey ? <BotCheck key={botCheckKey} siteKey={siteKey} onToken={setBotCheckToken} /> : null}
          <FormError message={shownError} />
          <Button type="submit" className="w-full" disabled={busy || needsBotCheck} data-testid="submit">
            {busy ? <Loader2Icon className="animate-spin" /> : null}
            {t("auth.sendCode")}
          </Button>
        </form>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-4" data-testid="forgot-code-form">
          <div className="space-y-1.5">
            <Label htmlFor="code">{t("auth.codeLabel")}</Label>
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="h-12 text-center font-mono text-xl tracking-[0.4em]"
              data-testid="reset-code"
            />
            <p className="text-xs text-muted-foreground">{t("auth.codeHint")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">{t("auth.newPassword")}</Label>
            <Input id="password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} value={password} onChange={(e) => setPassword(e.target.value)} data-testid="password" />
            <PasswordStrength score={score} />
            <p className="text-xs text-muted-foreground">{t("auth.passwordHint", { n: MIN_PASSWORD_LENGTH })}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm">{t("auth.confirmPassword")}</Label>
            <Input id="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="confirm" />
          </div>
          <FormError message={shownError} />
          <Button type="submit" className="w-full" disabled={busy} data-testid="submit">
            {busy ? <Loader2Icon className="animate-spin" /> : null}
            {t("auth.setNewPassword")}
          </Button>
          {siteKey && cooldown === 0 ? <BotCheck key={botCheckKey} siteKey={siteKey} onToken={setBotCheckToken} /> : null}
          <div className="flex items-center justify-between gap-3 text-sm">
            <button type="button" className="text-muted-foreground underline-offset-4 hover:underline disabled:no-underline disabled:opacity-60" onClick={() => void resend()} disabled={cooldown > 0 || busy || needsBotCheck} data-testid="resend-code">
              {cooldown > 0 ? t("auth.resendIn", { s: cooldown }) : t("auth.resendCode")}
            </button>
            <button
              type="button"
              className="text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => {
                authStore.getState().clearError();
                setLocalError(null);
                setCode("");
                setStep("email");
              }}
              data-testid="other-email"
            >
              {t("auth.otherEmail")}
            </button>
          </div>
        </form>
      )}
    </AuthLayout>
  );
}
