// Centered card used by the anonymous screens (login, register, password reset).

import type { ReactNode } from "react";
import { Link } from "react-router";
import { Logo } from "@/components/layout/Logo";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { LanguageToggle } from "@/components/settings/LanguageToggle";
import { useT } from "@/i18n";

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: string | undefined; children: ReactNode; footer?: ReactNode | undefined }) {
  const { t } = useT();
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex items-center justify-between px-4 py-3">
        <Link to="/login" className="flex items-center gap-2 font-semibold tracking-tight" aria-label="Tunnelio">
          <Logo className="size-6" />
          Tunnelio
        </Link>
        <div className="flex items-center gap-1">
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 py-6 md:items-center">
        <div className="w-full max-w-sm">
          <div className="rounded-2xl border bg-card p-6 shadow-sm">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
            <div className="mt-5">{children}</div>
          </div>
          {footer ? <div className="mt-4 text-center text-sm text-muted-foreground">{footer}</div> : null}
          <p className="mt-6 text-center text-[11px] text-muted-foreground/70">{t("auth.tagline")}</p>
        </div>
      </main>
    </div>
  );
}

/** Inline form error (server message or validation). */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-testid="form-error">
      {message}
    </p>
  );
}
