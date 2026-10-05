"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  BookOpen,
  CalendarClock,
  Boxes,
  DatabaseBackup,
  HardDrive,
  House,
  MessagesSquare,
  PanelLeft,
  Settings,
  X,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { WindowControls } from "@/components/layout/window-controls";
import { t } from "@/lib/locale";
import { cn } from "@/lib/utils/cn";

type NavItem = { href: string; label: string; icon: typeof BookOpen };

/**
 * The workspace navigation is one list, rendered once, so every page reaches
 * the same destinations under the same names.
 */
const NAV_ITEMS: NavItem[] = [
  { href: "/", label: t("nav.home"), icon: House },
  { href: "/chat", label: t("nav.chat"), icon: MessagesSquare },
  { href: "/tasks", label: "定时任务", icon: CalendarClock },
  { href: "/conversations", label: t("nav.conversations"), icon: MessagesSquare },
  { href: "/knowledge", label: t("nav.knowledge"), icon: BookOpen },
  { href: "/media", label: t("nav.media"), icon: HardDrive },
  { href: "/models", label: t("nav.models"), icon: Boxes },
  { href: "/backups", label: t("nav.backups"), icon: DatabaseBackup },
];

const noopSubscribe = () => () => {};

/**
 * Names the section for the top bar, so the row that holds the window controls
 * also says where you are instead of being an empty band. Matched longest-first
 * because the sections nest (`/knowledge/documents` under `/knowledge`).
 */
const SECTION_LABELS: { prefix: string; label: string }[] = [
  ...NAV_ITEMS.map(item => ({ prefix: item.href, label: item.label })),
  { prefix: "/storage", label: t("nav.storage") },
  { prefix: "/settings", label: t("nav.settings") },
];

function sectionLabel(pathname: string) {
  return SECTION_LABELS.filter(item => isActive(pathname, item.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]?.label ?? "";
}

function isActive(pathname: string, href: string) {
  // "/" is a prefix of every path, so the startsWith branch would light up the
  // home item on every page; the root is only active on an exact match.
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav aria-label={t("nav.label")} className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors",
              active
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            href={item.href}
            key={item.href}
            onClick={onNavigate}
          >
            <item.icon aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarBody({
  pathname,
  isDesktopRuntime,
  onNavigate,
}: {
  pathname: string;
  isDesktopRuntime: boolean;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto p-4">
      <div className="desktop-titlebar-drag -mx-1 flex items-center rounded-md px-1">
        <Link
          className="desktop-titlebar-interactive flex items-center gap-2 rounded-md px-2 py-1.5 text-lg font-semibold tracking-[-0.04em]"
          href="/chat"
          onClick={onNavigate}
        >
          <Image
            alt=""
            aria-hidden="true"
            className="h-5 w-5 rounded-[5px]"
            height={20}
            src="/icon.png"
            width={20}
          />
          {t("brand.name")}
        </Link>
      </div>
      <div className="space-y-3"><p className="px-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">工作空间</p><NavLinks onNavigate={onNavigate} pathname={pathname} /></div>
      <div className="mt-auto space-y-0.5">
        <Link
          className={cn(
            "flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors",
            isActive(pathname, "/storage")
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
          href="/storage"
          onClick={onNavigate}
        >
          <HardDrive aria-hidden="true" className="h-4 w-4 shrink-0" />
          {t("nav.storage")}
        </Link>
        {isDesktopRuntime ? (
          <Link
            className={cn(
              "flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors",
              isActive(pathname, "/settings")
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            href="/settings"
            onClick={onNavigate}
          >
            <Settings aria-hidden="true" className="h-4 w-4 shrink-0" />
            {t("nav.settings")}
          </Link>
        ) : null}
        <div className="flex items-center justify-between px-2 pt-2">
          <span className="label-mono">{t("nav.environment")}</span>
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}

/**
 * Persistent rail on wide screens, slide-over below `lg`. The chat view reads
 * as one application rather than a page with floating buttons on top of it.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // The drawer is open only for the route it was opened on, so navigating by
  // any means (link, back button) closes it without a synchronizing effect.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname;
  const drawerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    drawerRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, [open]);
  const setOpen = (next: boolean) => setOpenedOn(next ? pathname : null);
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1024px)");
    const close = () => setOpenedOn(null);
    wide.addEventListener("change", close);
    return () => wide.removeEventListener("change", close);
  }, []);
  // The preload bridge only exists under Electron. Hide the settings link in the
  // browser, where that page can render nothing but its "desktop only" error.
  // Read as an external store so the server render stays deterministic and no
  // effect has to cascade a second render to discover it.
  const isDesktopRuntime = useSyncExternalStore(
    noopSubscribe,
    () => Boolean(window.privateAiDesktop),
    () => false,
  );

  return (
    /*
      No top padding anywhere. The title-bar row is part of the interface: the
      nav rail runs the full height of the window with the brand sitting in that
      row, and the content column carries a header of the same height. Reserving
      a 40px band above both is what made the bar read as a foreign mask with a
      seam under it, and it wasted the space the brand and the section name now
      occupy.
    */
    <div data-desktop={isDesktopRuntime} data-chat-page={pathname === "/chat"} className="workspace-shell flex h-dvh min-h-0 overflow-hidden">
      {/*
        No separate drag strip. A `fixed` band above the header is a SIBLING, so
        it wins the hit test and swallows every click on the caption and the
        brand — `no-drag` only rescues an element from an ANCESTOR drag region.
        The drag region therefore lives on the real top-row elements below (the
        header bars and the rail's brand row), where interactive children can
        opt back out of it.
      */}

      <div className="workspace-rail z-40 hidden w-48 shrink-0 border-r lg:block">
        <SidebarBody pathname={pathname} isDesktopRuntime={isDesktopRuntime} />
      </div>

      {/*
        Narrow screens only: there is no room for a permanent rail, so the menu
        toggle and the section name need a bar of their own. It is the opaque
        surface content scrolls beneath, and the drag handle above it stays
        transparent — the bar supplies the paint.
      */}
      <header
        className={cn("workspace-topbar desktop-titlebar-drag absolute inset-x-0 top-0 z-30 flex h-11 items-center gap-2 border-b pl-3 lg:hidden", !isDesktopRuntime && "desktop-titlebar-plain")}
        onDoubleClick={() => window.privateAiDesktop?.windowControls?.toggleMaximize()}
      >
        <button
          aria-expanded={open}
          aria-label={t("nav.openMenu")}
          className="desktop-titlebar-interactive grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          onClick={() => setOpen(true)}
          type="button"
        >
          <PanelLeft aria-hidden="true" className="h-4 w-4" />
        </button>
        {/* A span, not a heading: every page owns its own <h1>, and two
            headings per page would break the document outline. */}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-label">
          {sectionLabel(pathname)}
        </span>
        <WindowControls />
      </header>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            aria-label={t("nav.closeMenu")}
            className="absolute inset-0 animate-overlay-in bg-foreground/20"
            onClick={() => setOpen(false)}
            type="button"
          />
          <div ref={drawerRef} role="dialog" aria-modal="true" aria-label={t("nav.label")} onKeyDown={event => {
            if (event.key === "Escape") setOpen(false);
            if (event.key === "Tab") {
              const controls = drawerRef.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled)');
              const first = controls?.[0];
              const last = controls?.[controls.length - 1];
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
          }} className="workspace-rail absolute inset-y-0 left-0 w-64 animate-panel-in-left border-r shadow-pop">
            <button
              aria-label={t("nav.closeMenu")}
              className="absolute right-2 top-3 grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
              onClick={() => setOpen(false)}
              type="button"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
            <SidebarBody
              isDesktopRuntime={isDesktopRuntime}
              onNavigate={() => setOpen(false)}
              pathname={pathname}
            />
          </div>
        </div>
      ) : null}

      {/* The header is a sibling of the content and shares this column, so the
          rail's brand and the section name line up in the same row. */}
      <div inert={open} className="flex min-h-0 min-w-0 flex-1 flex-col pt-11 lg:pt-0">
        <div
          className={cn("workspace-topbar desktop-titlebar-drag z-30 hidden h-11 shrink-0 items-center gap-2 border-b pl-5 lg:flex", !isDesktopRuntime && "desktop-titlebar-plain")}
          onDoubleClick={() => window.privateAiDesktop?.windowControls?.toggleMaximize()}
        >
          {/* A span, not a heading: every page owns its own <h1>, and two
              headings per page would break the document outline. */}
          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-label">
            {sectionLabel(pathname)}
          </span>
          <WindowControls />
        </div>
        <div className={cn("workspace-content min-h-0 min-w-0 flex-1", pathname === "/chat" ? "overflow-hidden" : "overflow-y-auto overscroll-contain")}>
          {children}
        </div>
      </div>
    </div>
  );
}
