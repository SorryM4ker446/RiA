"use client";
import { useLocale } from "@/lib/locale/client";

import { t } from "@/lib/locale";

import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Archive, BarChart3, BellRing, Cpu, FolderLock, HardDrive, KeyRound, Puzzle, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/layout/page-header";
import { WindowControls } from "@/components/layout/window-controls";
import { useDesktopRuntime } from "@/lib/use-desktop-runtime";
import { defaultSettingsSection, resolveSettingsSection, SETTINGS_PARAM, settingsUrl, type SettingsSectionId } from "@/lib/settings/sections";
import { SettingsContext, SettingsSectionContext, useSettingsContext } from "@/features/settings/settings-context";
import { ServiceSettings } from "@/features/settings/service-settings";
import { LanguageSettings } from "@/features/settings/language";
import { CloseBehaviourSettings } from "@/features/settings/close-behaviour";
import { HotkeySettings } from "@/features/settings/hotkey";
import { ScheduleSettings } from "@/features/settings/schedules";
import { NoticeCenter } from "@/features/settings/notice-center";
import { DirectoryGrantSettings } from "@/features/settings/directory-grants";
import { BackupSettings } from "@/features/settings/backup-settings";
import { ModelSettings } from "@/features/models/model-settings";
import { UsageSettings } from "@/features/models/usage-settings";
import { ExtensionManager } from "@/features/extensions/extension-manager";
import { StoragePanel } from "@/features/media/storage-panel";

/**
 * Settings open over the page in use instead of replacing it: closing them
 * returns to exactly where you were. The overlay is part of the address
 * (`?settings=<section>`), which is the only record of whether it is open.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  // Who reported unsaved edits, and in which section.
  const [unsaved, setUnsaved] = useState<ReadonlyMap<string, SettingsSectionId>>(() => new Map());
  const markUnsaved = useCallback((id: string, section: SettingsSectionId, value: boolean) => setUnsaved(current => {
    if (value === current.has(id)) return current;
    const next = new Map(current);
    if (value) next.set(id, section); else next.delete(id);
    return next;
  }), []);
  const unsavedSections = useMemo(() => new Set(unsaved.values()), [unsaved]);
  const pushedRef = useRef(false);
  const [anchor, setAnchor] = useState<string | null>(null);
  const open = useCallback((section?: SettingsSectionId, target?: string) => {
    const url = settingsUrl(section ?? defaultSettingsSection(Boolean(window.riaDesktop)));
    setAnchor(target ?? null);
    // Moving between sections replaces the entry, so going back closes the
    // overlay rather than stepping through every section visited.
    if (new URL(window.location.href).searchParams.has(SETTINGS_PARAM)) window.history.replaceState(null, "", url);
    else { pushedRef.current = true; window.history.pushState(null, "", url); }
  }, []);
  const clearAnchor = useCallback(() => setAnchor(null), []);
  const value = useMemo(() => ({ open, unsavedSections, markUnsaved, pushedRef, anchor, clearAnchor }), [open, unsavedSections, markUnsaved, anchor, clearAnchor]);
  return <SettingsContext.Provider value={value}>
    {children}
    {/* Reading the address suspends while a page is prerendered; only the overlay waits for it. */}
    <Suspense fallback={null}><SettingsOverlay /></Suspense>
  </SettingsContext.Provider>;
}

type NavItem = { id: SettingsSectionId; label: string; icon: typeof KeyRound };
const NAV_GROUPS = (): { label: string; items: NavItem[] }[] => [
  { label: t("ui.settingsOverlay.groupGeneral"), items: [
    { id: "services", label: t("ui.settings.servicesModels"), icon: KeyRound },
    { id: "application", label: t("ui.settings.application"), icon: SlidersHorizontal },
    { id: "automation", label: t("ui.settings.automationNotifications"), icon: BellRing },
    { id: "files", label: t("ui.settings.filePermissions"), icon: FolderLock },
  ] },
  { label: t("ui.settingsOverlay.groupModels"), items: [
    { id: "models", label: t("ui.settingsOverlay.models"), icon: Cpu },
    { id: "usage", label: t("ui.settingsOverlay.usage"), icon: BarChart3 },
    { id: "extensions", label: t("ui.settingsOverlay.extensions"), icon: Puzzle },
  ] },
  { label: t("ui.settingsOverlay.groupData"), items: [
    { id: "backups", label: t("backups.title"), icon: Archive },
    { id: "storage", label: t("ui.settingsOverlay.storage"), icon: HardDrive },
  ] },
];

function SectionContent({ id }: { id: SettingsSectionId }) {
  useLocale();
  switch (id) {
    case "services": return <ServiceSettings />;
    case "application": return <><PageHeader level={2} title={t("ui.settings.application")} /><div className="settings-panel flex flex-col"><LanguageSettings /><CloseBehaviourSettings /><HotkeySettings /></div></>;
    case "automation": return <><PageHeader level={2} title={t("ui.settings.automationNotifications")} /><div className="settings-panel flex flex-col"><ScheduleSettings /><NoticeCenter /></div></>;
    case "files": return <><PageHeader level={2} title={t("ui.settings.filePermissions")} /><div className="settings-panel"><DirectoryGrantSettings /></div></>;
    case "models": return <ModelSettings />;
    case "usage": return <UsageSettings />;
    case "extensions": return <ExtensionManager />;
    case "backups": return <BackupSettings />;
    case "storage": return <><PageHeader level={2} title={t("ui.settingsOverlay.storage")} description={t("mediaStorage.description")} /><StoragePanel embedded /></>;
  }
}

function SettingsOverlay() {
  useLocale();
  const context = useSettingsContext();
  const { unsavedSections, pushedRef, anchor, clearAnchor } = context;
  const confirm = useConfirm();
  const desktop = useDesktopRuntime();
  const router = useRouter();
  const raw = useSearchParams().get(SETTINGS_PARAM);
  const section = raw === null ? null : resolveSettingsSection(raw, desktop);
  // Kept while the overlay animates out, so it does not go blank as it closes.
  const [shown, setShown] = useState(section);
  if (section !== null && section !== shown) setShown(section);
  useEffect(() => { if (section === null) pushedRef.current = false; }, [section, pushedRef]);

  // Closing from here (the close button, Escape, a confirmed link) asks first
  // and then takes the settings out of the address. The address can also lose
  // them by other means: the browser's Back, or a navigation started outside
  // the overlay. With edits unsaved the overlay then stays up, held open, and
  // asks; keeping the edits puts the settings back into the address.
  const [observed, setObserved] = useState(section);
  const [leaving, setLeaving] = useState(false);
  const [held, setHeld] = useState(false);
  if (section !== observed) {
    setObserved(section);
    if (section !== null) { setHeld(false); setLeaving(false); }
    else if (!leaving && unsavedSections.size) setHeld(true);
  }

  const confirmDiscard = useCallback(() => confirm({
    title: t("ui.settingsOverlay.discardTitle"),
    description: t("ui.settingsOverlay.discardDescription"),
    action: t("ui.settingsOverlay.discard"),
    destructive: true,
  }), [confirm]);

  useEffect(() => {
    if (!held || !shown) return;
    let current = true;
    void confirmDiscard().then(discard => {
      if (!current) return;
      if (discard) setHeld(false);
      else { pushedRef.current = true; window.history.pushState(null, "", settingsUrl(shown)); }
    });
    return () => { current = false; };
  }, [held, shown, confirmDiscard, pushedRef]);

  const requestClose = useCallback(async () => {
    // A confirmation drawn by the section itself is answered first.
    if (document.querySelector("dialog[open]")) return;
    if (unsavedSections.size && !(await confirmDiscard())) return;
    setLeaving(true);
    if (pushedRef.current) { pushedRef.current = false; window.history.back(); }
    else window.history.replaceState(null, "", settingsUrl(null));
  }, [unsavedSections, confirmDiscard, pushedRef]);

  /**
   * A link inside the settings that leads to another page would drop unsaved
   * edits on the way out, so it asks before going. Links that stay in the
   * settings (another section, a part of this one) are left alone.
   */
  const guardLink = (event: React.MouseEvent) => {
    if (!unsavedSections.size || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element).closest?.("a[href]");
    if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || link.hasAttribute("download")) return;
    const url = new URL(link.href);
    if (url.origin !== window.location.origin || url.searchParams.has(SETTINGS_PARAM)) return;
    if (url.hash && url.pathname === window.location.pathname && url.search === window.location.search) return;
    event.preventDefault();
    event.stopPropagation();
    void confirmDiscard().then(discard => {
      if (!discard) return;
      setLeaving(true);
      router.push(`${url.pathname}${url.search}${url.hash}`);
    });
  };

  const select = useCallback((next: SettingsSectionId) => {
    clearAnchor();
    window.history.replaceState(null, "", settingsUrl(next));
  }, [clearAnchor]);

  return <Dialog.Root open={section !== null || held} onOpenChange={next => { if (!next) void requestClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="settings-scrim">
        {/* The overlay covers the window's own title row, so it carries the caption controls and the drag handle with it. */}
        {desktop ? <div className="settings-scrim-bar desktop-titlebar-drag"><WindowControls /></div> : null}
      </Dialog.Overlay>
      <Dialog.Content
        className="settings-window"
        aria-describedby={undefined}
        // Focus lands on the window itself, so opening with the mouse shows no focus ring; Tab enters the side list.
        onOpenAutoFocus={event => { event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }}
        onPointerDownOutside={event => { if ((event.target as Element | null)?.closest(".toast-stack, .settings-scrim-bar")) event.preventDefault(); }}
        onClickCapture={guardLink}
      >
        {shown ? <SettingsWindow section={shown} kept={unsavedSections} desktop={desktop} anchor={anchor} onAnchorShown={clearAnchor} onSelect={select} /> : null}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function SettingsWindow({ section, kept, desktop, anchor, onAnchorShown, onSelect }: { section: SettingsSectionId; kept: ReadonlySet<SettingsSectionId>; desktop: boolean; anchor: string | null; onAnchorShown: () => void; onSelect: (section: SettingsSectionId) => void }) {
  useLocale();
  const root = useRef<HTMLDivElement>(null);
  const groups = NAV_GROUPS();
  const order = groups.flatMap(group => group.items.map(item => item.id));
  // The open section, plus any section left with unsaved edits: those stay
  // mounted out of sight so their edits are still there on return. Every other
  // section reads fresh data when it is opened again.
  const mounted = order.filter(id => id === section || kept.has(id));
  // Storage is managed from the desktop app; the browser lists it only when a link opened it there.
  const visibleGroups = groups.map(group => ({ ...group, items: group.items.filter(item => item.id !== "storage" || desktop || section === "storage") }));

  // On a narrow window the side list becomes a scrolling row; keep the open section in view.
  useEffect(() => {
    root.current?.querySelector(`[role="tab"][data-state="active"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [section]);

  // A link can point at one part of a section. That part may only appear once
  // the section has loaded, so it is looked for as the section fills in.
  useEffect(() => {
    const panel = root.current?.querySelector(`.settings-window-panel[data-state="active"]`);
    if (!anchor || !panel) return;
    const reveal = () => {
      const target = panel.querySelector(`#${CSS.escape(anchor)}`);
      if (!target) return false;
      target.scrollIntoView({ block: "start" });
      onAnchorShown();
      return true;
    };
    if (reveal()) return;
    const observer = new MutationObserver(() => { if (reveal()) observer.disconnect(); });
    observer.observe(panel, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [anchor, section, onAnchorShown]);

  return <Tabs ref={root} value={section} onValueChange={value => onSelect(value as SettingsSectionId)} orientation="vertical" className="settings-window-body">
    <aside className="settings-window-nav">
      <Dialog.Title className="settings-window-title">{t("nav.settings")}</Dialog.Title>
      <TabsList aria-label={t("ui.settings.settingsCategories")} className="settings-window-tabs">
        {visibleGroups.map(group => <Fragment key={group.label}>
          <div role="presentation" className="settings-window-group">{group.label}</div>
          {group.items.map(item => <TabsTrigger key={item.id} value={item.id} className="side-nav-item"><item.icon aria-hidden="true" />{item.label}</TabsTrigger>)}
        </Fragment>)}
      </TabsList>
    </aside>
    <Dialog.Close asChild>
      <Button className="settings-window-close" variant="ghost" size="icon-sm" aria-label={t("ui.settingsOverlay.close")}><X aria-hidden="true" /></Button>
    </Dialog.Close>
    {/* Each section scrolls on its own, so one kept in the background is still where it was left. */}
    {mounted.map(id => <TabsContent key={id} value={id} forceMount className="settings-window-panel data-[state=inactive]:hidden">
      <SettingsSectionContext.Provider value={id}><div className="settings-window-page"><SectionContent id={id} /></div></SettingsSectionContext.Provider>
    </TabsContent>)}
  </Tabs>;
}
