import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Loader2Icon } from "lucide-react";
import { afterLogin } from "@/app/bootstrap";
import { AuthLayout, FormError } from "@/components/auth/AuthLayout";
import { PasswordStrength, usePasswordScore } from "@/components/auth/PasswordStrength";
import { BotCheck } from "@/components/auth/BotCheck";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n";
import { MIN_PASSWORD_LENGTH as MIN_PASSWORD, checkPassword } from "@/lib/password";
import { strengthHints, tooWeak } from "@/lib/strength";
import { authStore } from "@/stores/auth";
import { useAuth } from "@/stores/react";

export function RegisterScreen() {
  const { t } = useT();
  const loc = useLocation();
  const navigate = useNavigate();
  const busy = useAuth((s) => s.busy);
  const error = useAuth((s) => s.error);
  const flags = useAuth((s) => s.flags);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [botCheckToken, setBotCheckToken] = useState<string | null>(null);
  const score = usePasswordScore(password, strengthHints(email));

  useEffect(() => () => authStore.getState().clearError(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const problem = checkPassword(password);
    if (problem === "short") return setLocalError(t("auth.passwordTooShort", { n: MIN_PASSWORD }));
    if (problem === "common") return setLocalError(t("auth.passwordCommon"));
    let weak: boolean;
    try {
      weak = await tooWeak(password, strengthHints(email));
    } catch {
      return setLocalError(t("auth.strengthCheckFailed"));
    }
    if (weak) return setLocalError(t("auth.passwordWeak"));
    if (password !== confirm) return setLocalError(t("auth.passwordMismatch"));
    const result = await authStore.getState().register(email.trim(), password, botCheckToken ?? undefined);
    if (result === "signed_in") await afterLogin();
    else if (result === "verify") navigate("/verify-email", { state: loc.state });
  };

  if (!flags.registration_enabled) {
    return (
      <AuthLayout title={t("auth.registerTitle")} footer={<Link to="/login" className="underline-offset-4 hover:underline">{t("auth.backToLogin")}</Link>}>
        <p className="text-sm text-muted-foreground" data-testid="registration-closed">
          {t("auth.registrationClosed")}
        </p>
      </AuthLayout>
    );
  }

  const needsBotCheck = Boolean(flags.bot_check_site_key) && !botCheckToken;

  return (
    <AuthLayout
      title={t("auth.registerTitle")}
      subtitle={t("auth.registerSubtitle")}
      footer={
        <span>
          {t("auth.haveAccount")}{" "}
          <Link to="/login" state={loc.state} className="font-medium text-foreground underline-offset-4 hover:underline" data-testid="link-login">
            {t("auth.login")}
          </Link>
        </span>
      }
    >
      {/* noValidate: the checks below show their message; the browser's own (required, minLength) say nothing on iOS Safari. */}
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4" data-testid="register-form">
        <div className="space-y-1.5">
          <Label htmlFor="email">{t("auth.email")}</Label>
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} data-testid="email" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">{t("auth.password")}</Label>
          <Input id="password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} value={password} onChange={(e) => setPassword(e.target.value)} data-testid="password" />
          <PasswordStrength score={score} />
          <p className="text-xs text-muted-foreground">{t("auth.passwordHint", { n: MIN_PASSWORD })}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm">{t("auth.confirmPassword")}</Label>
          <Input id="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="confirm" />
        </div>
        {flags.bot_check_site_key ? <BotCheck siteKey={flags.bot_check_site_key} onToken={setBotCheckToken} /> : null}
        <FormError message={localError ?? error} />
        {needsBotCheck ? (
          <p className="text-xs text-muted-foreground" data-testid="bot-check-waiting">
            {t("auth.botCheckWaiting")}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={busy || needsBotCheck} data-testid="submit">
          {busy ? <Loader2Icon className="animate-spin" /> : null}
          {t("auth.createAccount")}
        </Button>
      </form>
    </AuthLayout>
  );
}
