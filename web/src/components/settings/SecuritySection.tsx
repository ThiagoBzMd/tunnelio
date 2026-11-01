// Settings → Account → Security (rev. 1.3): two-step sign-in (TOTP), change password (disconnects the
// devices), delete account. Rows of the settings window (./layout.tsx).

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Loader2Icon } from "lucide-react";
import QRCode from "react-qr-code";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/i18n";
import { PasswordStrength, usePasswordScore } from "@/components/auth/PasswordStrength";
import { MIN_PASSWORD_LENGTH, checkPassword } from "@/lib/password";
import { strengthHints, tooWeak } from "@/lib/strength";
import { authStore } from "@/stores/auth";
import { useAuth } from "@/stores/react";
import { uiStore } from "@/stores/ui";
import { SettingsRow, SettingsSection } from "./layout";

export function SecuritySection() {
  const { t } = useT();
  return (
    <SettingsSection title={t("settings.security")} description={t("settings.securityIntro")} testid="settings-security">
      <TwoStep />
      <ChangePassword />
      <DeleteAccount />
    </SettingsSection>
  );
}

const digits = (v: string) => v.replace(/\D/g, "").slice(0, 6);

function TwoStep() {
  const { t } = useT();
  const enabled = useAuth((s) => s.me?.totp_enabled ?? false);
  const busy = useAuth((s) => s.busy);
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);

  const start = async () => {
    const res = await authStore.getState().totpSetup();
    if (res) setSetup(res);
    else toast.error(authStore.getState().error ?? t("settings.twoStep"));
  };

  return (
    <div data-testid="two-step" data-enabled={enabled ? "true" : "false"}>
      <SettingsRow
        label={t("settings.twoStep")}
        hint={
          <>
            {t("settings.twoStepHint")}
            {enabled ? <span className="mt-1 block">{t("settings.twoStepLost")}</span> : null}
          </>
        }
      >
        <Switch checked={enabled} disabled={busy} onCheckedChange={(on) => (on ? void start() : setDisableOpen(true))} aria-label={t("settings.twoStep")} data-testid="two-step-switch" />
      </SettingsRow>
      <TwoStepSetupDialog setup={setup} onClose={() => setSetup(null)} />
      <TwoStepDisableDialog open={disableOpen} onOpenChange={setDisableOpen} />
    </div>
  );
}

function TwoStepSetupDialog({ setup, onClose }: { setup: { secret: string; otpauth_url: string } | null; onClose(): void }) {
  const { t } = useT();
  const busy = useAuth((s) => s.busy);
  const errorCode = useAuth((s) => s.errorCode);
  const error = useAuth((s) => s.error);
  const [code, setCode] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await authStore.getState().totpEnable(code)) {
      toast.success(t("settings.twoStepEnabled"));
      setCode("");
      onClose();
    }
  };
  const shownError = errorCode === "E_BAD_CODE" ? t("settings.twoStepBadCode") : error;
  return (
    <Dialog open={setup !== null} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md" data-testid="two-step-setup">
        <DialogHeader>
          <DialogTitle>{t("settings.twoStepSetupTitle")}</DialogTitle>
          <DialogDescription>{t("settings.twoStepSetupDescription")}</DialogDescription>
        </DialogHeader>
        {setup ? (
          <form onSubmit={(e) => void submit(e)} className="space-y-4">
            <div className="mx-auto w-fit rounded-lg bg-white p-3" data-testid="two-step-qr">
              <QRCode value={setup.otpauth_url} size={168} />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("settings.twoStepSecret")}</p>
              <p className="rounded-md border bg-muted/50 px-3 py-2 text-center font-mono text-sm tracking-wider break-all select-all" data-testid="two-step-secret">
                {setup.secret}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="two-step-code">{t("settings.twoStepCode")}</Label>
              <Input
                id="two-step-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(digits(e.target.value))}
                className="h-12 text-center font-mono text-xl tracking-[0.4em]"
                data-testid="two-step-code"
              />
            </div>
            {shownError ? (
              <p role="alert" className="text-sm text-destructive">
                {shownError}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy || code.length !== 6} data-testid="two-step-enable">
                {busy ? <Loader2Icon className="animate-spin" /> : null}
                {t("settings.twoStepEnable")}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TwoStepDisableDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const { t } = useT();
  const busy = useAuth((s) => s.busy);
  const errorCode = useAuth((s) => s.errorCode);
  const error = useAuth((s) => s.error);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await authStore.getState().totpDisable(password, code)) {
      toast.success(t("settings.twoStepDisabled"));
      setPassword("");
      setCode("");
      onOpenChange(false);
    }
  };
  const shownError = errorCode === "E_BAD_CODE" ? t("settings.twoStepBadCode") : error;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="two-step-disable">
        <DialogHeader>
          <DialogTitle>{t("settings.twoStepDisableTitle")}</DialogTitle>
          <DialogDescription>{t("settings.twoStepDisableDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <Input type="password" autoComplete="current-password" placeholder={t("auth.password")} required value={password} onChange={(e) => setPassword(e.target.value)} data-testid="two-step-disable-password" />
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            required
            placeholder={t("settings.twoStepCode")}
            value={code}
            onChange={(e) => setCode(digits(e.target.value))}
            className="h-12 text-center font-mono text-xl tracking-[0.4em]"
            data-testid="two-step-disable-code"
          />
          {shownError ? (
            <p role="alert" className="text-sm text-destructive">
              {shownError}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="destructive" disabled={busy || !password || code.length !== 6} data-testid="two-step-disable-confirm">
              {busy ? <Loader2Icon className="animate-spin" /> : null}
              {t("settings.twoStepDisable")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChangePassword() {
  const { t } = useT();
  const navigate = useNavigate();
  const busy = useAuth((s) => s.busy);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const email = useAuth((s) => s.me?.email ?? "");
  const score = usePasswordScore(next, strengthHints(email));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const problem = checkPassword(next);
    if (problem === "short") return setLocalError(t("auth.passwordTooShort", { n: MIN_PASSWORD_LENGTH }));
    if (problem === "common") return setLocalError(t("auth.passwordCommon"));
    if (await tooWeak(next, strengthHints(email))) return setLocalError(t("auth.passwordWeak"));
    if (await authStore.getState().changePassword(current, next)) {
      toast.success(t("settings.passwordChanged"));
      setCurrent("");
      setNext("");
      uiStore.getState().closeSettings();
      navigate("/devices"); // every computer was disconnected: pair again
    } else toast.error(authStore.getState().error ?? t("settings.passwordChangeFailed"));
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="py-4" data-testid="change-password-form">
      <Label className="text-[14px] font-normal">{t("settings.changePassword")}</Label>
      <p className="mt-0.5 text-[13px] text-muted-foreground">{t("settings.changePasswordHint")}</p>
      <div className="mt-3 grid max-w-sm gap-2">
        <Input type="password" autoComplete="current-password" placeholder={t("settings.currentPassword")} required value={current} onChange={(e) => setCurrent(e.target.value)} className="h-9" data-testid="current-password" />
        <Input type="password" autoComplete="new-password" placeholder={t("settings.newPassword")} required minLength={MIN_PASSWORD_LENGTH} value={next} onChange={(e) => setNext(e.target.value)} className="h-9" data-testid="new-password" />
        <PasswordStrength score={score} />
        {localError ? <p className="text-sm text-destructive">{localError}</p> : null}
        <Button type="submit" variant="outline" className="h-9 w-fit rounded-lg" disabled={busy} data-testid="change-password">
          {t("settings.changePassword")}
        </Button>
      </div>
    </form>
  );
}

function DeleteAccount() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const busy = useAuth((s) => s.busy);
  return (
    <div>
      <SettingsRow label={t("settings.deleteAccount")} hint={t("settings.deleteAccountHint")}>
        <Button variant="outline" className="h-9 rounded-lg text-destructive hover:text-destructive" onClick={() => setOpen(true)} data-testid="delete-account">
          {t("settings.deleteAccount")}
        </Button>
      </SettingsRow>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.deleteAccountConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.deleteAccountConfirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <Input type="password" autoComplete="current-password" placeholder={t("auth.password")} value={password} onChange={(e) => setPassword(e.target.value)} data-testid="delete-account-password" />
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !password}
              onClick={(e) => {
                e.preventDefault();
                void authStore
                  .getState()
                  .deleteAccount(password)
                  .then((ok) => {
                    if (!ok) toast.error(authStore.getState().error ?? t("settings.deleteAccountFailed"));
                  });
              }}
              data-testid="delete-account-confirm"
            >
              {t("settings.deleteAccount")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
