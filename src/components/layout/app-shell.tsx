"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
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
  Layers3,
  Images,
  SlidersHorizontal,
  Puzzle,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { WindowControls } from "@/components/layout/window-controls";
import { t } from "@/lib/locale";
import { cn } from "@/lib/utils/cn";
import { useDesktopRuntime } from "@/lib/use-desktop-runtime";

type NavItem = { href: string; label: string; icon: typeof BookOpen };

/**
 * The workspace navigation is one list, rendered once, so every page reaches
 * the same destinations under the same names.
 */
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  { label: "日常", items: [
  { href: "/", label: t("nav.home"), icon: House },
  { href: "/chat", label: t("nav.chat"), icon: MessagesSquare },
  { href: "/assistants", label: "助理模板", icon: Boxes },
  { href: "/tasks", label: "定时任务", icon: CalendarClock },
  ] },
  { label: "资料", items: [
  { href: "/conversations", label: t("nav.conversations"), icon: MessagesSquare },
  { href: "/knowledge", label: t("nav.knowledge"), icon: BookOpen },
  { href: "/document-processor", label: "文档处理器", icon: FileText },
  { href: "/topics", label: "知识专题", icon: Layers3 },
  { href: "/media", label: t("nav.media"), icon: Images },
  ] },
  { label: "管理", items: [
  { href: "/models", label: t("nav.models"), icon: SlidersHorizontal },
  { href: "/extensions", label: "扩展管理", icon: Puzzle },
  { href: "/backups", label: t("nav.backups"), icon: DatabaseBackup },
  ] },
];

/**
 * Names the section for the top bar, so the row that holds the window controls
 * also says where you are instead of being an empty band. Matched longest-first
 * because the sections nest (`/knowledge/documents` under `/knowledge`).
 */
const SECTION_LABELS: { prefix: string; label: string }[] = [
  ...NAV_GROUPS.flatMap(group => group.items.map(item => ({ prefix: item.href, label: item.label }))),
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
    <nav aria-label={t("nav.label")} className="workspace-navigation flex flex-col gap-6">
      {NAV_GROUPS.map(group => <div key={group.label} className="flex flex-col gap-1">
        <p className="workspace-nav-label px-3 pb-1">{group.label}</p>
        {group.items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className="workspace-nav-link group"
            href={item.href}
            key={item.href}
            onClick={onNavigate}
          >
            <item.icon aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}</div>)}
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
    <div className="flex h-full min-h-0 flex-col gap-7 overflow-y-auto px-3 pb-4">
      <div className="desktop-titlebar-drag flex h-16 shrink-0 items-center px-2">
        <Link
          className="desktop-titlebar-interactive workspace-brand flex items-center gap-2.5 rounded-lg px-1 py-2 text-xl font-semibold tracking-title"
          href="/chat"
          aria-label={t("brand.name")}
          onClick={onNavigate}
        >
          <span className="workspace-brand-wordmark">{t("brand.name")}</span>
        </Link>
      </div>
      <NavLinks onNavigate={onNavigate} pathname={pathname} />
      <div className="mt-auto flex flex-col gap-1 border-t pt-3">
        {isDesktopRuntime ? <Link
          aria-current={isActive(pathname, "/storage") ? "page" : undefined}
          className="workspace-nav-link"
          href="/storage"
          onClick={onNavigate}
        >
          <HardDrive aria-hidden="true" className="h-4 w-4 shrink-0" />
          {t("nav.storage")}
        </Link> : null}
        <div className="flex items-center gap-1 pr-2">
          <Link
            aria-current={isActive(pathname, isDesktopRuntime ? "/settings" : "/storage") ? "page" : undefined}
            className="workspace-nav-link min-w-0 flex-1"
            href={isDesktopRuntime ? "/settings" : "/storage"}
            onClick={onNavigate}
          >
            {isDesktopRuntime ? <Settings aria-hidden="true" className="size-4 shrink-0" /> : <HardDrive aria-hidden="true" className="size-4 shrink-0" />}
            {t(isDesktopRuntime ? "nav.settings" : "nav.storage")}
          </Link>
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
  const isDesktopRuntime = useDesktopRuntime();

  return (
    /*
      No top padding anywhere. The title-bar row is part of the interface: the
      nav rail runs the full height of the window with the brand sitting in that
      row, and the content column carries a header of the same height. Reserving
      a 40px band above both is what made the bar read as a foreign mask with a
      seam under it, and it wasted the space the brand and the section name now
      occupy.
    */
    <Sheet open={open} onOpenChange={setOpen}>
    <div data-desktop={isDesktopRuntime} data-chat-page={pathname === "/chat"} className="workspace-shell flex h-dvh min-h-0 overflow-hidden">
      {/*
        No separate drag strip. A `fixed` band above the header is a SIBLING, so
        it wins the hit test and swallows every click on the caption and the
        brand — `no-drag` only rescues an element from an ANCESTOR drag region.
        The drag region therefore lives on the real top-row elements below (the
        header bars and the rail's brand row), where interactive children can
        opt back out of it.
      */}

      <div className="workspace-rail hidden w-52 shrink-0 border-r lg:block">
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
        <SheetTrigger asChild><Button
          aria-expanded={open}
          aria-label={t("nav.openMenu")}
          className="desktop-titlebar-interactive"
          variant="ghost"
          size="icon-sm"
          type="button"
        >
          <PanelLeft aria-hidden="true" className="h-4 w-4" />
        </Button></SheetTrigger>
        {/* A span, not a heading: every page owns its own <h1>, and two
            headings per page would break the document outline. */}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-label">
          {sectionLabel(pathname)}
        </span>
        <WindowControls />
      </header>

      <SheetContent className="workspace-rail" closeLabel={t("nav.closeMenu")} aria-describedby={undefined}>
            <SheetTitle className="sr-only">{t("nav.label")}</SheetTitle>
            <SidebarBody
              isDesktopRuntime={isDesktopRuntime}
              onNavigate={() => setOpen(false)}
              pathname={pathname}
            />
      </SheetContent>

      {/* The header is a sibling of the content and shares this column, so the
          rail's brand and the section name line up in the same row. */}
      <div className="workspace-main flex min-h-0 min-w-0 flex-1 flex-col pt-11 lg:pt-0">
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
    </Sheet>
  );
}
