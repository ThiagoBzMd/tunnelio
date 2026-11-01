import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Loader2Icon } from "lucide-react";
import { afterLogin } from "@/app/bootstrap";
import { AuthLayout, FormError } from "@/components/auth/AuthLayout";
import { BotCheck } from "@/components/auth/BotCheck";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n";
import { authStore } from "@/stores/auth";
import { useAuth } from "@/stores/react";

export function LoginScreen() {
  const { t } = useT();
  const loc = useLocation();
  const navigate = useNavigate();
  const busy = useAuth((s) => s.busy);
  const error = useAuth((s) => s.error);
  const errorCode = useAuth((s) => s.errorCode);
  const totpRequired = useAuth((s) => s.totpRequired);
  const flags = useAuth((s) => s.flags);
  // After a password reset whose automatic sign-in did not go through (e.g. rate limit).
  const handoff = loc.state as { email?: unknown; notice?: unknown } | null;
  const [email, setEmail] = useState(typeof handoff?.email === "string" ? handoff.email : "");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [botCheckToken, setBotCheckToken] = useState<string | null>(null);

  useEffect(() => () => authStore.getState().clearError(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await authStore.getState().login(email.trim(), password, botCheckToken ?? undefined, totpRequired && totp ? totp : undefined);
    if (ok) {
      await afterLogin();
      return;
    }
    if (authStore.getState().pendingVerification) navigate("/verify-email", { state: loc.state });
  };

  const needsBotCheck = Boolean(flags.bot_check_site_key) && !botCheckToken;
  const shownError = errorCode === "E_TOTP_REQUIRED" ? null : errorCode === "E_TOTP_INVALID" ? t("auth.totpInvalid") : error;

  return (
    <AuthLayout
      title={t("auth.loginTitle")}
      subtitle={t("auth.loginSubtitle")}
      footer={
        flags.registration_enabled ? (
          <span>
            {t("auth.noAccount")}{" "}
            <Link to="/register" state={loc.state} className="font-medium text-foreground underline-offset-4 hover:underline" data-testid="link-register">
              {t("auth.createAccount")}
            </Link>
          </span>
        ) : (
          <span>{t("auth.registrationClosed")}</span>
        )
      }
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4" data-testid="login-form" data-totp={totpRequired ? "true" : "false"}>
        {handoff?.notice === "reset" ? (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="login-notice">
            {t("auth.resetSignIn")}
          </p>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="email">{t("auth.email")}</Label>
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} data-testid="email" />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">{t("auth.password")}</Label>
            {flags.email_enabled ? (
              <Link to="/forgot-password" className="text-xs text-muted-foreground underline-offset-4 hover:underline" data-testid="link-forgot">
                {t("auth.forgot")}
              </Link>
            ) : null}
          </div>
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} data-testid="password" />
        </div>
        {totpRequired ? (
          <div className="space-y-1.5">
            <Label htmlFor="totp">{t("auth.totpCode")}</Label>
            <Input
              id="totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              required
              autoFocus
              value={totp}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="h-12 text-center font-mono text-xl tracking-[0.4em]"
              data-testid="totp-code"
            />
            <p className="text-xs text-muted-foreground">{t("auth.totpHint")}</p>
          </div>
        ) : null}
        {flags.bot_check_site_key ? <BotCheck siteKey={flags.bot_check_site_key} onToken={setBotCheckToken} /> : null}
        <FormError message={shownError} />
        <Button type="submit" className="w-full" disabled={busy || needsBotCheck || (totpRequired && totp.length !== 6)} data-testid="submit">
          {busy ? <Loader2Icon className="animate-spin" /> : null}
          {t("auth.login")}
        </Button>
      </form>
    </AuthLayout>
  );
}
