// Pairing dialog: 12-symbol code → SPAKE2 through the relay (SPEC §4). The code never reaches
// the server; only the 4-symbol claim does (inside `pairDevice`).

import { useEffect, useRef, useState } from "react";
import { CheckCircle2Icon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useT, type TKey } from "@/i18n";
import { formatPairingCode, isCompletePairingCode } from "@/lib/format";
import { pairDevice, PairingError, type PairingStep } from "@/pairing/flow";
import { authStore } from "@/stores/auth";
import { devicesStore } from "@/stores/devices";
import { getRuntime } from "@/stores/runtime";
import { sessionsStore } from "@/stores/sessions";

type Phase = "input" | "working" | "done" | "error";

const STEP_KEYS: Record<PairingStep, TKey> = {
  joining: "pair.stepJoining",
  pake1: "pair.stepVerifying",
  pake2: "pair.stepVerifying",
  pake3: "pair.stepConfirming",
  result: "pair.stepConfirming",
};

const ERROR_KEYS: Record<string, TKey> = {
  E_CODE_INVALID: "pair.errInvalid",
  E_PAIR_NOT_FOUND: "pair.errNotFound",
  E_PAIR_EXPIRED: "pair.errExpired",
  E_PAIR_BUSY: "pair.errBusy",
  E_PAIR_FAILED: "pair.errFailed",
  E_BAD_MAC: "pair.errFailed",
  E_RATE_LIMIT: "pair.errRateLimit",
  E_TIMEOUT: "pair.errTimeout",
  E_DISCONNECTED: "pair.errDisconnected",
};

export interface PairDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Pre-filled code (deep link `/pair#CODE`). */
  initialCode?: string;
  autoStart?: boolean;
  /** Restrict the dialog to one device (card button) — informational only. */
  deviceName?: string;
}

export function PairDialog({ open, onOpenChange, initialCode, autoStart, deviceName }: PairDialogProps) {
  const { t } = useT();
  const [code, setCode] = useState(() => formatPairingCode(initialCode ?? ""));
  const [phase, setPhase] = useState<Phase>("input");
  const [step, setStep] = useState<PairingStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<{ device_id: string; name: string } | null>(null);
  const started = useRef(false);

  const start = async (value: string) => {
    if (!isCompletePairingCode(value) || phase === "working") return;
    setPhase("working");
    setError(null);
    setStep("joining");
    const rt = getRuntime();
    rt.relay.connect(); // no-op when already connecting/ready; covers the /pair#CODE deep link racing bootstrap
    try {
      const record = await pairDevice(rt.relay, value, { store: rt.storage.pairings, onStep: setStep });
      sessionsStore.getState().close(record.device_id); // next open() uses the fresh pairing
      devicesStore.getState().markPaired(record.device_id, record.name);
      await devicesStore.getState().refresh(); // merges + pushes the new pairing to the other browsers
      authStore.getState().clearDisconnected();
      setPaired({ device_id: record.device_id, name: record.name });
      setPhase("done");
      toast.success(t("pair.success", { name: record.name }));
    } catch (e) {
      const key = e instanceof PairingError ? ERROR_KEYS[e.code] : undefined;
      setError(key ? t(key) : e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  useEffect(() => {
    if (open && autoStart && !started.current && isCompletePairingCode(code)) {
      started.current = true;
      void start(code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoStart, code]);

  return (
    <Dialog open={open} onOpenChange={(o) => (phase === "working" ? undefined : onOpenChange(o))}>
      <DialogContent className="sm:max-w-md" data-testid="pair-dialog">
        <DialogHeader>
          <DialogTitle>{deviceName ? t("pair.titleFor", { name: deviceName }) : t("pair.title")}</DialogTitle>
          <DialogDescription>{t("pair.description")}</DialogDescription>
        </DialogHeader>

        {phase === "done" && paired ? (
          <div className="flex flex-col items-center gap-2 py-4 text-center" data-testid="pair-success">
            <CheckCircle2Icon className="size-10 text-emerald-500" />
            <p className="font-medium">{t("pair.success", { name: paired.name })}</p>
            <p className="text-sm text-muted-foreground">{t("pair.successHint")}</p>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void start(code);
            }}
          >
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t("pair.step1")}</li>
              <li>{t("pair.step2")}</li>
              <li>{t("pair.step3")}</li>
            </ol>
            <Input
              value={code}
              onChange={(e) => setCode(formatPairingCode(e.target.value))}
              placeholder="XXXX-XXXX-XXXX"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              disabled={phase === "working"}
              className="h-12 text-center font-mono text-lg tracking-[0.2em]"
              aria-label={t("pair.codeLabel")}
              data-testid="pair-code"
            />
            {phase === "working" && step ? (
              <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground" data-testid="pair-step" data-step={step}>
                <Loader2Icon className="size-4 animate-spin" />
                {t(STEP_KEYS[step])}
              </p>
            ) : null}
            {phase === "error" && error ? (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-testid="pair-error">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={phase === "working"}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!isCompletePairingCode(code) || phase === "working"} data-testid="pair-submit">
                {phase === "working" ? <Loader2Icon className="animate-spin" /> : null}
                {phase === "error" ? t("common.retry") : t("pair.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
        {phase === "done" ? (
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} data-testid="pair-close">
              {t("common.done")}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
