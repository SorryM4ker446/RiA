"use client";
import { useLocale } from "@/lib/locale/client";

import { t } from "@/lib/locale";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  CalendarClock,
  Boxes,
  House,
  MessagesSquare,
  Settings,
  Layers3,
  Images,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { WindowControls } from "@/components/layout/window-controls";
import { CommandPalette, CommandSearchButton } from "@/features/commands/command-palette";
import { RailResizer } from "@/components/layout/rail-resizer";
import { RailControls, RailFoldButton } from "@/components/layout/rail-controls";
import { useRailLayout } from "@/components/layout/rail-layout";
import { AppTooltips } from "@/components/ui/app-tooltips";
import { cn } from "@/lib/utils/cn";
import { useDesktopRuntime } from "@/lib/use-desktop-runtime";
import { useOpenSettings } from "@/features/settings/settings-context";
import { UpdateNotice } from "@/features/updates/update-notice";

type NavItem = { href: string; label: string; icon: typeof BookOpen };

/**
 * The workspace navigation is one list, rendered once, so every page reaches
 * the same destinations under the same names.
 */
const NAV_GROUPS = (): { label: string; items: NavItem[] }[] => ([
  { label: t("ui.layout.app-shell.everyday"), items: [
  { href: "/", label: t("nav.home"), icon: House },
  { href: "/chat", label: t("nav.chat"), icon: MessagesSquare },
  { href: "/assistants", label: t("ui.assistants.assistantTemplates"), icon: Boxes },
  { href: "/tasks", label: t("tasks.title"), icon: CalendarClock },
  ] },
  { label: t("ui.layout.app-shell.knowledge"), items: [
  { href: "/conversations", label: t("nav.conversations"), icon: MessagesSquare },
  { href: "/knowledge", label: t("nav.knowledge"), icon: BookOpen },
  { href: "/topics", label: t("ui.backups.knowledgeTopics"), icon: Layers3 },
  { href: "/media", label: t("nav.media"), icon: Images },
  ] },
]);

/**
 * Names the section for the top bar, so the row that holds the window controls
 * also says where you are instead of being an empty band. Matched longest-first
 * because the sections nest (`/knowledge/documents` under `/knowledge`).
 */
const SECTION_LABELS = (): { prefix: string; label: string }[] =>
  NAV_GROUPS().flatMap(group => group.items.map(item => ({ prefix: item.href, label: item.label })));

function sectionLabel(pathname: string) {
  return SECTION_LABELS().filter(item => isActive(pathname, item.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]?.label ?? "";
}

function isActive(pathname: string, href: string) {
  // "/" is a prefix of every path, so the startsWith branch would light up the
  // home item on every page; the root is only active on an exact match.
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({ pathname }: { pathname: string }) {
  useLocale();
  return (
    <nav aria-label={t("nav.label")} className="workspace-navigation flex flex-col gap-6">
      {NAV_GROUPS().map(group => <div key={group.label} className="flex flex-col gap-1">
        <p className="workspace-nav-label px-3 pb-1">{group.label}</p>
        {group.items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className="workspace-nav-link group"
            href={item.href}
            key={item.href}
          >
            <item.icon aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 whitespace-normal break-words leading-5">{item.label}</span>
          </Link>
        );
      })}</div>)}
    </nav>
  );
}

/** `action`: the sidebar button at the right of the header, which folds or pins it. */
function SidebarBody({ pathname, action }: { pathname: string; action: React.ReactNode }) {
  useLocale();
  const openSettings = useOpenSettings();
  return (
    <div className="workspace-sidebar-body flex h-full min-h-0 flex-col gap-7 overflow-y-auto px-3 pb-4">
      {/* The same height as the page's top row: the brand on the left, the sidebar
          button at the right edge, quiet until pointed at. */}
      <div className="workspace-sidebar-header desktop-titlebar-drag flex h-11 shrink-0 items-center justify-between gap-2 pl-1">
        <Link
          className="desktop-titlebar-interactive workspace-brand flex items-center gap-2.5 rounded-lg px-1 py-1 text-xl font-semibold tracking-title"
          href="/chat"
          aria-label={t("brand.name")}
        >
          <span className="workspace-brand-wordmark">{t("brand.name")}</span>
        </Link>
        {action}
      </div>
      <NavLinks pathname={pathname} />
      {/* Everything that configures the app lives in one settings overlay, opened over the current page. */}
      <div className="mt-auto flex flex-col gap-1 border-t pt-3">
        <UpdateNotice />
        <div className="flex items-center gap-1 pr-2">
          <button
            type="button"
            aria-haspopup="dialog"
            className="workspace-nav-link min-w-0 flex-1"
            onClick={() => openSettings()}
          >
            <Settings aria-hidden="true" className="size-4 shrink-0" />
            {t("nav.settings")}
          </button>
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}

/**
 * A sidebar that can be widened, narrowed or folded away, and a top row shared
 * by every page. Folded (always, at first, on a narrow window), it is shown
 * over the page from the sidebar button and pinned back in place by clicking it.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  useLocale();
  const pathname = usePathname();
  const { folded } = useRailLayout();
  // Opening a collapsed section (a <details> anywhere: a page, the settings, a
  // sheet) brings what it revealed into view instead of leaving it below the
  // fold. Only an opening the person asked for counts: a section rendered open
  // also fires "toggle", and that must not move the page as it loads.
  useEffect(() => {
    const requested = new WeakSet<HTMLDetailsElement>();
    const mark = (event: Event) => {
      const summary = (event.target as Element | null)?.closest?.("summary");
      if (summary?.parentElement instanceof HTMLDetailsElement) requested.add(summary.parentElement);
    };
    // Some sections only render their content once they are open, a moment
    // after "toggle". The section is watched until it has grown past its
    // heading, and scrolled then; one section is watched at a time.
    let watching: ResizeObserver | null = null;
    const reveal = (event: Event) => {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement) || !requested.has(details)) return;
      requested.delete(details);
      watching?.disconnect();
      watching = null;
      if (!details.open) return;
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const heading = details.querySelector(":scope > summary");
      const observer = new ResizeObserver(() => {
        if (!details.open || !details.isConnected) { observer.disconnect(); return; }
        if (details.getBoundingClientRect().height <= (heading?.getBoundingClientRect().height ?? 0) + 1) return;
        observer.disconnect();
        // Scroll the area that holds it just far enough to show what opened,
        // but never so far that the heading that was clicked leaves the top.
        let scroller = details.parentElement;
        while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
        if (!scroller) return;
        const area = scroller.getBoundingClientRect(), opened = details.getBoundingClientRect(), margin = 16;
        const distance = Math.min(opened.bottom + margin - area.bottom, opened.top - margin - area.top);
        if (distance > 0) scroller.scrollBy({ top: distance, behavior: smooth ? "smooth" : "auto" });
      });
      observer.observe(details);
      watching = observer;
    };
    document.addEventListener("click", mark, true);
    // "toggle" does not bubble, so it is caught on the way down.
    document.addEventListener("toggle", reveal, true);
    return () => { document.removeEventListener("click", mark, true); document.removeEventListener("toggle", reveal, true); watching?.disconnect(); };
  }, []);
  // Each page keeps where it was scrolled to for as long as the window is open,
  // so leaving a long list and coming back lands on the same rows. Pages load
  // their content after they mount, so the position is applied again as the
  // content grows, until it can be reached or the user scrolls on their own.
  const scrollPositions = useRef(new Map<string, number>());
  useEffect(() => {
    const content = document.querySelector<HTMLElement>(".workspace-content");
    if (!content) return;
    const target = scrollPositions.current.get(pathname) ?? 0;
    let restoring = target > 0;
    const save = () => { if (!restoring) scrollPositions.current.set(pathname, content.scrollTop); };
    const release = () => { restoring = false; growth.disconnect(); clearTimeout(giveUp); };
    const apply = () => {
      if (!restoring) return;
      content.scrollTo({ top: target, behavior: "instant" });
      if (Math.abs(content.scrollTop - target) < 2) release();
    };
    const growth = new ResizeObserver(apply);
    const giveUp = setTimeout(release, 1500);
    const intent = () => release();
    if (restoring) {
      for (const child of content.children) growth.observe(child);
      requestAnimationFrame(apply);
    } else clearTimeout(giveUp);
    content.addEventListener("scroll", save, { passive: true });
    for (const event of ["wheel", "pointerdown", "keydown", "touchstart"]) content.addEventListener(event, intent, { passive: true });
    return () => {
      release();
      content.removeEventListener("scroll", save);
      for (const event of ["wheel", "pointerdown", "keydown", "touchstart"]) content.removeEventListener(event, intent);
    };
  }, [pathname]);
  // The preload bridge only exists under Electron. Read as an external store so
  // the server render stays deterministic and no effect has to cascade a second
  // render to discover it.
  const isDesktopRuntime = useDesktopRuntime();
  // The section name in the top row repeats the page title, so it stays out of sight while that
  // title is on screen and fades in once it scrolls away. Pages render their header late at times
  // (after a load), so the heading being watched is looked up again whenever the content changes.
  const [titleInView, setTitleInView] = useState(false);
  useEffect(() => {
    const content = document.querySelector<HTMLElement>(".workspace-content");
    if (!content) return;
    let watched: Element | null = null;
    const intersection = new IntersectionObserver(([entry]) => setTitleInView(entry.isIntersecting), { root: content });
    const attach = () => {
      const heading = content.querySelector(".workspace-page-header h1");
      if (heading === watched) return;
      if (watched) intersection.unobserve(watched);
      watched = heading;
      if (heading) intersection.observe(heading); else setTitleInView(false);
    };
    attach();
    const mutations = new MutationObserver(attach);
    mutations.observe(content, { childList: true, subtree: true });
    return () => { mutations.disconnect(); intersection.disconnect(); };
  }, []);

  return (
    /*
      No top padding anywhere. The title-bar row is part of the interface: the
      nav rail runs the full height of the window with the brand sitting in that
      row, and the content column carries a header of the same height. Reserving
      a 40px band above both is what made the bar read as a foreign mask with a
      seam under it, and it wasted the space the brand and the section name now
      occupy.
    */
    <>
      <CommandPalette pages={NAV_GROUPS().flatMap(group => group.items)} />
      <AppTooltips />
    <div data-desktop={isDesktopRuntime} data-chat-page={pathname === "/chat"} className="workspace-shell relative flex h-dvh min-h-0 overflow-hidden">
      {/*
        No separate drag strip. A `fixed` band above the header is a SIBLING, so
        it wins the hit test and swallows every click on the caption and the
        brand — `no-drag` only rescues an element from an ANCESTOR drag region.
        The drag region therefore lives on the real top-row elements below (the
        header bar and the rail's brand row), where interactive children can
        opt back out of it.
      */}

      {/* Its width follows `--rail-width`; the content keeps that width while the rail
          folds, so it slides away clipped instead of re-wrapping on the way. Folded,
          it is inert: the sidebar shown over the page is the one in use. */}
      <div className="workspace-rail workspace-rail-docked shrink-0">
        <div className="workspace-rail-inner h-full" inert={folded || undefined}>
          <SidebarBody pathname={pathname} action={<RailFoldButton />} />
        </div>
      </div>

      {/* The header is a sibling of the content and shares this column, so the
          rail's brand and the section name line up in the same row. */}
      <div className="workspace-main flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className={cn("workspace-topbar desktop-titlebar-drag relative z-30 flex h-11 shrink-0 items-center gap-2 border-b pl-5", !isDesktopRuntime && "desktop-titlebar-plain")}
          onDoubleClick={() => window.riaDesktop?.windowControls?.toggleMaximize()}
        >
          {/* A span, not a heading: every page owns its own <h1>, and two
              headings per page would break the document outline. */}
          <span className="workspace-section-title min-w-0 flex-1 truncate text-sm font-semibold tracking-label" data-concealed={titleInView || undefined} aria-hidden={titleInView || undefined}>
            {sectionLabel(pathname)}
          </span>
          {pathname === "/chat" && <CommandSearchButton />}
          <WindowControls />
        </div>
        <div className={cn("workspace-content min-h-0 min-w-0 flex-1", pathname === "/chat" ? "overflow-hidden" : "overflow-y-auto overscroll-contain")}>
          {children}
        </div>
      </div>
      {/* Last on purpose. The desktop window reads drag regions in document
          order, so a control lying over the top row must come after it, or the
          row's drag region claims its clicks and the pointer never reaches it. */}
      <RailResizer />
      <RailControls renderBody={action => <SidebarBody pathname={pathname} action={action} />} />
    </div>
    </>
  );
}
