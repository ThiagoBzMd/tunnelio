// Top bar shared by every screen: the sidebar button (mobile, or desktop with the sidebar
// unpinned), the title or custom content, actions on the right. No rule under it.

import type { ReactNode } from "react";
import { cn } from "cn";
import { SidebarToggle } from "./AppShell";

export function ScreenHeader({ title, children, actions, className }: { title?: string; children?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cn("flex h-14 shrink-0 items-center gap-1 bg-background px-2 md:px-3", className)}>
      <SidebarToggle />
      {title ? <h1 className="truncate px-1.5 text-[15px] font-medium">{title}</h1> : null}
      {children}
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div> : null}
    </header>
  );
}

/** Scrollable body with a comfortable reading width. */
export function ScreenBody({ children, className, wide = false }: { children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn("mx-auto w-full space-y-6 p-4 pb-safe md:p-6", wide ? "max-w-5xl" : "max-w-3xl", className)}>{children}</div>
    </div>
  );
}
