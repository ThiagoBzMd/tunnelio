// The lines above the box: why the composer is disabled, what blocks the send, warnings, a stalled
// stream. One at a time, in that order of precedence (the stalled notice shows alongside).

import { useT } from "@/i18n";

export function ComposerNotices({ disabledReason, blocked, warnings, stalled }: { disabledReason: string | null; blocked: string | null; warnings: string[]; stalled: boolean }) {
  const { t } = useT();
  return (
    <>
      {disabledReason ? (
        <p className="mb-2 text-center text-xs text-muted-foreground" data-testid="composer-disabled-reason">
          {disabledReason}
        </p>
      ) : null}
      {!disabledReason && blocked ? (
        <p role="alert" className="mb-2 text-center text-xs text-destructive" data-testid="composer-blocked">
          {blocked}
        </p>
      ) : null}
      {!disabledReason && !blocked
        ? warnings.map((w) => (
            <p key={w} className="mb-2 text-center text-xs text-amber-600 dark:text-amber-400" data-testid="composer-warning">
              {w}
            </p>
          ))
        : null}
      {stalled ? (
        <p className="mb-2 text-center text-xs text-amber-600 dark:text-amber-400" data-testid="composer-stalled">
          {t("chat.stalled")}
        </p>
      ) : null}
    </>
  );
}
