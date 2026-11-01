// Sidebar: the sidebar button and the wordmark, search, "New chat", navigation, pinned
// conversations, then each computer's conversations split by date; the account menu at the bottom.
// `mode` tells where it is shown (docked, floating panel or drawer) and what the top-left button
// does there. The phone drawer is laid out differently (DrawerParts.tsx): a larger wordmark, search
// behind a round button, and at the bottom the account's initials (→ Settings) and a floating "New
// chat".

import { useMemo, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { BotIcon, BoxesIcon, ChevronDownIcon, EllipsisIcon, MonitorSmartphoneIcon, PanelLeftIcon, PinIcon, PinOffIcon, PlusIcon, ScrollTextIcon, SearchIcon, Trash2Icon, XIcon } from "lucide-react";
import { cn } from "cn";
import { toast } from "sonner";
import { startNewChat } from "@/app/actions";
import { useRelayState } from "@/app/relay";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { localeOf, useT, type TKey } from "@/i18n";
import { relativeTime } from "@/lib/format";
import { historyStore } from "@/stores/history";
import { useSettings } from "@/stores/react";
import { settingsStore } from "@/stores/settings";
import { AccountMenu } from "./AccountMenu";
import { DownloadsIndicator } from "@/components/models/Downloads";
import { DrawerFooter, DrawerSearchButton } from "./DrawerParts";
import { matchesQuery, sectionize, useConversationGroups, useConversationLoader, type ConvGroup, type ConvItem, type DateBucket } from "./conversations";

const BUCKET_LABEL: Record<DateBucket, TKey> = { today: "sidebar.today", yesterday: "sidebar.yesterday", week: "sidebar.last7", month: "sidebar.last30", older: "sidebar.older" };

export type SidebarMode = "docked" | "peek" | "drawer";

export function Sidebar({ mode, onCollapse, onNavigate }: { mode: SidebarMode; onCollapse(): void; onNavigate?: (() => void) | undefined }) {
  const { t } = useT();
  const navigate = useNavigate();
  const loc = useLocation();
  const groups = useConversationGroups();
  useConversationLoader();
  const pinnedIds = useSettings((s) => s.settings.pinned_conversations);
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const drawer = mode === "drawer";
  const [searchOpen, setSearchOpen] = useState(false);

  // Search filters titles across every computer; pinned conversations move to their own section.
  const { pinned, shown } = useMemo(() => {
    const filtered = searching ? groups.map((g) => ({ ...g, items: g.items.filter((c) => matchesQuery(c.title, query)) })) : groups;
    const byId = new Map<string, ConvItem>();
    for (const g of filtered) for (const c of g.items) byId.set(c.id, c);
    const pinnedItems = pinnedIds.map((id) => byId.get(id)).filter((c): c is ConvItem => Boolean(c));
    const pinnedSet = new Set(pinnedItems.map((c) => c.id));
    const rest = filtered.map((g) => ({ ...g, items: g.items.filter((c) => !pinnedSet.has(c.id)), pinnedOut: g.items.some((c) => pinnedSet.has(c.id)) }));
    return { pinned: pinnedItems, shown: searching ? rest.filter((g) => g.items.length > 0) : rest };
  }, [groups, pinnedIds, query, searching]);

  const activeConversation = loc.pathname.startsWith("/chat/") ? loc.pathname.slice("/chat/".length) : null;
  const collapseLabel = mode === "peek" ? t("sidebar.show") : t("sidebar.hide");

  const nav = [
    { to: "/devices", icon: MonitorSmartphoneIcon, label: t("nav.devices"), active: loc.pathname === "/devices" || loc.pathname === "/pair", testid: "nav-devices" },
    { to: "/models", icon: BoxesIcon, label: t("nav.models"), active: loc.pathname === "/models", testid: "nav-models" },
    { to: "/agents", icon: BotIcon, label: t("nav.agents"), active: loc.pathname === "/agents", testid: "nav-agents" },
    { to: "/skills", icon: ScrollTextIcon, label: t("nav.skills"), active: loc.pathname === "/skills", testid: "nav-skills" },
  ];

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-testid="sidebar" data-mode={mode}>
      <div className={cn("flex shrink-0 items-center gap-1.5", drawer ? "h-16 px-4" : "h-14 px-2")}>
        {drawer ? null : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground [&_svg]:size-5" onClick={onCollapse} aria-label={collapseLabel} data-testid="sidebar-collapse">
                <PanelLeftIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{collapseLabel}</TooltipContent>
          </Tooltip>
        )}
        <span className={cn("font-serif font-medium tracking-tight", drawer ? "text-[28px]" : "text-[20px]")}>Tunnelio</span>
        <RelayDot />
        {drawer ? <DrawerSearchButton open={searchOpen} onToggle={() => setSearchOpen((o) => !o)} /> : null}
      </div>

      <div className={cn("px-2 pb-2", drawer && !searchOpen && !query && "hidden")}>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("sidebar.search")}
            autoFocus={drawer && searchOpen}
            aria-label={t("sidebar.search")}
            className="h-9 w-full rounded-lg border border-sidebar-border bg-transparent pr-8 pl-9 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
            data-testid="conversation-search"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={t("sidebar.clearSearch")}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
              data-testid="conversation-search-clear"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <nav className="grid gap-px px-2" aria-label={t("nav.menu")}>
        {drawer ? null : (
          <button
            type="button"
            onClick={() => {
              startNewChat(navigate);
              onNavigate?.();
            }}
            className={cn(navItemClass, loc.pathname === "/" && "bg-sidebar-accent text-sidebar-accent-foreground")}
            data-testid="new-chat"
          >
            <PlusIcon />
            {t("chat.new")}
          </button>
        )}
        {nav.map((item) => (
          <NavLink key={item.to} to={item.to} onClick={onNavigate} className={cn(navItemClass, drawer && drawerItemClass, item.active && "bg-sidebar-accent text-sidebar-accent-foreground")} data-testid={item.testid}>
            <item.icon />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <DownloadsIndicator onNavigate={onNavigate} />

      <div className={cn("mt-4 min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2", drawer ? "pb-28" : "pb-2")} data-testid="conversation-list">
        {pinned.length > 0 ? (
          <Collapsible label={t("sidebar.pinned")} testid="conversation-section-pinned">
            <ul className={listClass}>
              {pinned.map((c) => (
                <Item key={c.id} item={c} pinned active={c.id === activeConversation} onNavigate={onNavigate} />
              ))}
            </ul>
          </Collapsible>
        ) : null}
        {shown.length === 0 && pinned.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-xs text-muted-foreground" data-testid={searching ? "conversation-search-empty" : undefined}>
            {searching ? t("sidebar.noResults") : t("sidebar.empty")}
          </p>
        ) : (
          shown.map((g) => <Group key={g.key} group={g} activeId={activeConversation} onNavigate={onNavigate} />)
        )}
      </div>

      {drawer ? (
        <DrawerFooter onNavigate={onNavigate} />
      ) : (
        <div className="shrink-0 p-2">
          <AccountMenu onNavigate={onNavigate} />
        </div>
      )}
    </div>
  );
}

const navItemClass =
  "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] text-sidebar-foreground/90 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:opacity-80";
/** The phone drawer's navigation: larger rows, easier to tap. */
const drawerItemClass = "h-12 gap-4 px-3 text-[17px] [&_svg]:size-[22px]";
const listClass = "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-px";

function RelayDot() {
  const state = useRelayState();
  const { t } = useT();
  const label = state === "ready" ? t("relay.connected") : state === "connecting" || state === "waiting" ? t("relay.connecting") : t("relay.disconnected");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("size-1.5 rounded-full", state === "ready" ? "bg-emerald-500" : state === "idle" || state === "closed" ? "bg-muted-foreground/40" : "animate-pulse bg-amber-500")}
          aria-label={label}
          data-testid="relay-dot"
          data-state={state}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** A section with a small muted title and a chevron that folds it ("Pinned", a computer). */
function Collapsible({ label, dot, testid, extra, children }: { label: string; dot?: boolean | undefined; testid: string; extra?: Record<string, string>; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="mb-3" data-testid={testid} {...extra}>
      <button type="button" className="group/sec flex h-8 w-full items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-muted-foreground hover:text-foreground" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {dot !== undefined ? <span className={cn("size-1.5 shrink-0 rounded-full", dot ? "bg-emerald-500" : "bg-muted-foreground/40")} /> : null}
        <span className="truncate">{label}</span>
        <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform", open ? "" : "-rotate-90")} />
      </button>
      {open ? children : null}
    </section>
  );
}

/** One computer: its conversations split by date. */
function Group({ group, activeId, onNavigate }: { group: ConvGroup & { pinnedOut?: boolean }; activeId: string | null; onNavigate?: (() => void) | undefined }) {
  const { t } = useT();
  const sections = sectionize(group.items);
  return (
    <Collapsible label={group.name || t("devices.unnamed")} dot={group.online} testid={`conversation-group-${group.key}`} extra={{ "data-online": String(group.online) }}>
      {!group.online ? (
        <p className="px-2.5 py-1.5 text-xs text-muted-foreground" data-testid="conversation-group-offline">
          {t("sidebar.offline")}
        </p>
      ) : group.items.length === 0 ? (
        // Every conversation of this computer is pinned: nothing more to list here.
        group.pinnedOut ? null : <p className="px-2.5 py-1.5 text-xs text-muted-foreground">{group.loading ? t("common.loading") : t("sidebar.noConversations")}</p>
      ) : (
        sections.map((s) => (
          <div key={s.bucket} data-testid={`conversation-section-${s.bucket}`}>
            <p className="px-2.5 pt-2 pb-1 text-xs text-muted-foreground/80">{t(BUCKET_LABEL[s.bucket])}</p>
            <ul className={listClass}>
              {s.items.map((c) => (
                <Item key={c.id} item={c} active={c.id === activeId} onNavigate={onNavigate} />
              ))}
            </ul>
          </div>
        ))
      )}
    </Collapsible>
  );
}

function Item({ item, active, pinned = false, onNavigate }: { item: ConvItem; active: boolean; pinned?: boolean; onNavigate?: (() => void) | undefined }) {
  const { t, lang } = useT();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const remove = async () => {
    const ok = await historyStore.getState().deletePrivate(item.device_id, item.id);
    if (!ok) toast.error(t("sidebar.deleteFailed"));
    else {
      if (pinned) void settingsStore.getState().setPinned(item.id, false);
      if (active) navigate("/");
    }
  };

  return (
    <li className={cn("group/item relative flex min-w-0 items-center rounded-lg", active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70")} data-pinned={pinned ? "true" : "false"}>
      <NavLink
        to={`/chat/${item.id}`}
        onClick={onNavigate}
        className="block h-8 min-w-0 flex-1 truncate py-1.5 pr-8 pl-2.5 text-[14px] leading-5 text-sidebar-foreground/90"
        title={relativeTime(item.updated_at, localeOf(lang))}
        data-testid="conversation-item"
        data-conversation-id={item.id}
      >
        {item.title || t("chat.untitled")}
      </NavLink>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              "absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground hover:text-foreground [&_svg]:size-4",
              // Touch screens have no hover: always shown there; with a mouse, on hover (or while open).
              !menuOpen && !active && "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/item:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100",
            )}
            data-testid="conversation-menu"
            aria-label={t("common.more")}
          >
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuItem onSelect={() => void settingsStore.getState().setPinned(item.id, !pinned)} data-testid="conversation-pin">
            {pinned ? <PinOffIcon /> : <PinIcon />}
            {pinned ? t("sidebar.unpin") : t("sidebar.pin")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => void remove()} data-testid="conversation-delete">
            <Trash2Icon />
            {t("common.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
