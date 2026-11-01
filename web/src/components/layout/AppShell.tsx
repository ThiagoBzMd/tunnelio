// Authenticated layout: the sidebar and the main column.
//   Desktop: the sidebar is docked while pinned (settings.sidebar_pinned). Unpinned, hovering the
//   button at the top left shows the same sidebar over the content; clicking pins it again.
//   Mobile: a drawer (sheet) opened by the same button.
//   Anonymous chat: no sidebar; a frame with "Anonymous" and a button to leave.
// The app-wide windows (settings, language, keyboard shortcuts) and shortcuts live here too.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { GhostIcon, PanelLeftIcon, TextAlignStartIcon, XIcon } from "lucide-react";
import { cn } from "cn";
import { startNewChat } from "@/app/actions";
import { LanguageDialog } from "@/components/settings/LanguageDialog";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/i18n";
import { isApplePlatform, matchShortcut } from "@/lib/shortcuts";
import { useSettings, useUi } from "@/stores/react";
import { settingsStore } from "@/stores/settings";
import { uiStore } from "@/stores/ui";
import { phoneRoundButton } from "./phone";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { Sidebar } from "./Sidebar";

interface ShellApi {
  /** The sidebar button: pin/unpin on desktop, open the drawer on mobile. */
  toggleSidebar(): void;
  closeDrawer(): void;
  peekEnter(): void;
  peekLeave(): void;
}

const ShellContext = createContext<ShellApi>({ toggleSidebar: () => undefined, closeDrawer: () => undefined, peekEnter: () => undefined, peekLeave: () => undefined });

export function useShell(): ShellApi {
  return useContext(ShellContext);
}

const isDesktop = () => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;

export function AppShell() {
  const { t } = useT();
  const loc = useLocation();
  const navigate = useNavigate();
  const pinned = useSettings((s) => s.settings.sidebar_pinned);
  const peek = useUi((s) => s.peek);
  const frame = useUi((s) => s.incognitoFrame);
  const [drawer, setDrawer] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peekRef = useRef<HTMLDivElement>(null);

  // Close the drawer and the floating panel after any navigation (adjusted during render).
  if (path !== loc.pathname) {
    setPath(loc.pathname);
    if (drawer) setDrawer(false);
    if (peek) uiStore.getState().setPeek(false);
  }

  const setPinned = useCallback((on: boolean) => {
    uiStore.getState().setPeek(false);
    void settingsStore.getState().update({ sidebar_pinned: on });
  }, []);

  const api = useMemo<ShellApi>(
    () => ({
      toggleSidebar: () => (isDesktop() ? setPinned(!settingsStore.getState().settings.sidebar_pinned) : setDrawer((o) => !o)),
      closeDrawer: () => setDrawer(false),
      peekEnter: () => {
        if (leaveTimer.current) clearTimeout(leaveTimer.current);
        leaveTimer.current = null;
        if (isDesktop() && !settingsStore.getState().settings.sidebar_pinned) uiStore.getState().setPeek(true);
      },
      peekLeave: () => {
        if (leaveTimer.current) clearTimeout(leaveTimer.current);
        leaveTimer.current = setTimeout(() => {
          // Still under the pointer (the panel opened right over the button), or a menu opened
          // from it (account, conversation "…", which lives outside the panel): keep it.
          if (peekRef.current?.matches(":hover")) return;
          if (document.querySelector('[data-slot="dropdown-menu-content"][data-state="open"]')) return;
          uiStore.getState().setPeek(false);
        }, 250);
      },
    }),
    [setPinned],
  );

  // A click outside the floating panel closes it (menus it opened count as inside).
  useEffect(() => {
    if (!peek) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target || peekRef.current?.contains(target)) return;
      if (target.closest('[data-slot="dropdown-menu-content"], [data-testid="sidebar-toggle"]')) return;
      uiStore.getState().setPeek(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [peek]);

  // Keyboard shortcuts (lib/shortcuts.ts).
  useEffect(() => {
    const apple = isApplePlatform();
    const onKey = (e: KeyboardEvent) => {
      const id = matchShortcut(e, apple);
      if (!id) return;
      e.preventDefault();
      if (id === "newChat") startNewChat(navigate);
      else if (id === "toggleSidebar") api.toggleSidebar();
      else if (id === "settings") uiStore.getState().openSettings("general");
      else uiStore.getState().setShortcuts(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [api, navigate]);

  const leaveIncognito = () => startNewChat(navigate);

  return (
    <ShellContext.Provider value={api}>
      <div className={cn("flex h-dvh w-full flex-col overflow-hidden", frame ? "bg-foreground text-background" : "bg-background")} data-incognito={frame ? "true" : "false"}>
        {frame ? (
          <div className="flex h-11 shrink-0 items-center gap-2 pr-2 pl-4" data-testid="incognito-bar">
            <GhostIcon className="size-5" />
            <span className="text-sm font-medium">{t("chat.incognitoTitle")}</span>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto text-background hover:bg-background/15 hover:text-background [&_svg]:size-5"
              onClick={leaveIncognito}
              aria-label={t("chat.incognitoExit")}
              data-testid="incognito-exit"
            >
              <XIcon />
            </Button>
          </div>
        ) : null}
        <div className={cn("flex min-h-0 flex-1", frame && "mx-1.5 mb-1.5 overflow-hidden rounded-2xl md:mx-2 md:mb-2")}>
          {!frame && pinned ? (
            <aside className="hidden w-72 shrink-0 bg-sidebar text-sidebar-foreground md:flex md:flex-col" data-testid="sidebar-desktop">
              <Sidebar mode="docked" onCollapse={() => setPinned(false)} />
            </aside>
          ) : null}
          <main className="relative flex min-w-0 flex-1 flex-col bg-background text-foreground">
            <Outlet />
          </main>
        </div>
      </div>

      {!frame && !pinned && peek ? (
        <div
          ref={peekRef}
          // Same shape as the docked sidebar (flush left, full height), just over the content.
          className="fixed inset-y-0 left-0 z-40 hidden w-72 flex-col overflow-hidden bg-sidebar text-sidebar-foreground shadow-[4px_0_24px_rgba(0,0,0,0.12)] duration-150 animate-in fade-in-0 slide-in-from-left-4 md:flex"
          onMouseEnter={api.peekEnter}
          onMouseLeave={api.peekLeave}
          data-testid="sidebar-peek"
        >
          <Sidebar mode="peek" onCollapse={() => setPinned(true)} />
        </div>
      ) : null}

      {!frame ? (
        <Sheet open={drawer} onOpenChange={setDrawer}>
          <SheetContent side="left" className="w-[86vw] max-w-[320px] gap-0 bg-sidebar p-0 text-sidebar-foreground" showCloseButton={false} data-testid="sidebar-sheet">
            <SheetTitle className="sr-only">{t("nav.menu")}</SheetTitle>
            <SheetDescription className="sr-only">{t("nav.menuDescription")}</SheetDescription>
            <Sidebar mode="drawer" onCollapse={() => setDrawer(false)} onNavigate={() => setDrawer(false)} />
          </SheetContent>
        </Sheet>
      ) : null}

      <SettingsDialog />
      <LanguageDialog />
      <ShortcutsDialog />
    </ShellContext.Provider>
  );
}

/**
 * The sidebar button of each screen's header: always on mobile (opens the drawer); on desktop only
 * while the sidebar is not pinned — hovering shows it floating, clicking pins it.
 */
export function SidebarToggle() {
  const shell = useShell();
  const { t } = useT();
  const pinned = useSettings((s) => s.settings.sidebar_pinned);
  const frame = useUi((s) => s.incognitoFrame);
  if (frame) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("shrink-0 text-muted-foreground hover:text-foreground [&_svg]:size-5", phoneRoundButton, pinned && "md:hidden")}
          onClick={shell.toggleSidebar}
          onMouseEnter={shell.peekEnter}
          onMouseLeave={shell.peekLeave}
          aria-label={t("sidebar.show")}
          data-testid="sidebar-toggle"
        >
          {/* A phone opens a menu (three lines); a desktop shows/pins the sidebar. */}
          <TextAlignStartIcon className="md:hidden" />
          <PanelLeftIcon className="max-md:hidden" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{t("sidebar.show")}</TooltipContent>
    </Tooltip>
  );
}
