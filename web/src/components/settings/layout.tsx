// Settings window building blocks: a titled section of rows separated by hairlines, and a row with
// a label (and hint) on the left and its control on the right. A phone page that already carries
// the section's title in its header hides the section's own (WithoutSectionTitles).

import { createContext, useContext, type ReactNode } from "react";
import { cn } from "cn";

const SectionTitles = createContext(true);

export function WithoutSectionTitles({ children }: { children: ReactNode }) {
  return <SectionTitles.Provider value={false}>{children}</SectionTitles.Provider>;
}

export function SettingsSection({ title, description, children, testid, className }: { title: string; description?: string; children: ReactNode; testid?: string; className?: string }) {
  const showTitle = useContext(SectionTitles);
  return (
    <section className={cn("mb-10 last:mb-0", className)} data-testid={testid}>
      {showTitle ? <h3 className="text-base font-medium">{title}</h3> : null}
      {description ? <p className={cn("text-[13px] text-muted-foreground", showTitle ? "mt-1" : "pt-4")}>{description}</p> : null}
      <div className="mt-2 divide-y divide-border">{children}</div>
    </section>
  );
}

export function SettingsRow({ label, hint, children, testid, className }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; testid?: string; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4", className)} data-testid={testid}>
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-[14px]">{label}</div>
        {hint ? <div className="mt-0.5 text-[13px] text-muted-foreground">{hint}</div> : null}
      </div>
      {children !== undefined ? <div className="shrink-0">{children}</div> : null}
    </div>
  );
}
