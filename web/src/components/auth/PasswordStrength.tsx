// The strength meter under a new password (lib/strength.ts): four bars and a word, from "very
// weak" to "strong". Below MIN_STRENGTH the form refuses the password and says why.

import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";
import { useT, type TKey } from "@/i18n";
import { loadStrength, MIN_STRENGTH, type StrengthCheck, type StrengthScore } from "@/lib/strength";

const LABEL: Record<StrengthScore, TKey> = { 0: "auth.strength0", 1: "auth.strength1", 2: "auth.strength2", 3: "auth.strength3", 4: "auth.strength4" };
const COLOR: Record<StrengthScore, string> = { 0: "bg-destructive", 1: "bg-destructive", 2: "bg-amber-500", 3: "bg-emerald-500", 4: "bg-emerald-600" };

/** The score of `password` (null while empty or while the dictionaries load). */
export function usePasswordScore(password: string, hints: readonly string[]): StrengthScore | null {
  const [check, setCheck] = useState<StrengthCheck | null>(null);
  useEffect(() => {
    let alive = true;
    loadStrength()
      .then((c) => {
        if (alive) setCheck(() => c);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const key = hints.join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (check && password ? check(password, hints) : null), [check, password, key]);
}

export function PasswordStrength({ score }: { score: StrengthScore | null }) {
  const { t } = useT();
  if (score === null) return null;
  const filled = Math.max(score, 1);
  return (
    <div className="space-y-1" data-testid="password-strength" data-score={score} aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={cn("h-1 flex-1 rounded-full transition-colors", i <= filled ? COLOR[score] : "bg-muted")} />
        ))}
      </div>
      <p className={cn("text-xs", score < MIN_STRENGTH ? "text-destructive" : "text-muted-foreground")}>{t(LABEL[score])}</p>
    </div>
  );
}
