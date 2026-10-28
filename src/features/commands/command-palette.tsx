"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType, type PointerEvent as ReactPointerEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { CornerDownLeft, Cpu, GripHorizontal, Keyboard, MessageSquarePlus, MessagesSquare, PanelRight, Pin, Search, Settings2, TextCursorInput, X } from "lucide-react";
import { t } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { cn } from "@/lib/utils/cn";
import { useOpenSettings } from "@/features/settings/settings-context";
import { settingsSections } from "@/features/settings/settings-overlay";
import { conversationsApi, type Conversation } from "@/features/conversations/api-client";
import { sendChatCommand, type ChatCommand } from "@/features/commands/chat-commands";
import { modelRefKey, type ModelLibraryItem } from "@/lib/models/preferences-schema";

type Icon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
type Item = { id: string; group: string; label: string; icon: Icon; hint?: string; run: () => void };
export type PalettePage = { href: string; label: string; icon: Icon };

/** Ctrl on Windows and Linux, ⌘ on macOS. */
const modifierLabel = () => (typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl");
const withModifier = (event: KeyboardEvent) => (/Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey) && !event.altKey;
const EDGE = 8;
type Position = { left: number; top: number };
/** Keeps a moved panel whole inside the window. */
const clampToWindow = (left: number, top: number, width: number, height: number): Position => ({
  left: Math.min(Math.max(EDGE, left), Math.max(EDGE, window.innerWidth - width - EDGE)),
  top: Math.min(Math.max(EDGE, top), Math.max(EDGE, window.innerHeight - height - EDGE)),
});

const OPEN_EVENT = "ria:open-command-palette";
/** Marks a control that opens the palette, so pressing it never counts as clicking away. */
const PALETTE_TRIGGER = "data-command-palette-trigger";

/**
 * A slim search field in the title-bar row that opens the palette. It names
 * the shortcut, so the keyboard path is learnt by seeing it.
 */
export function CommandSearchButton() {
  useLocale();
  return (
    <button
      type="button"
      className="command-search desktop-titlebar-interactive"
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K"
      {...{ [PALETTE_TRIGGER]: "" }}
      // The row toggles maximise on double-click; a quick second press here must not.
      onDoubleClick={event => event.stopPropagation()}
      onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}
    >
      <Search aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{t("commands.search")}</span>
      <kbd className="command-search-key" suppressHydrationWarning>{modifierLabel()} K</kbd>
    </button>
  );
}

/** Every keyboard shortcut, as the help panel lists them. */
export function shortcutList() {
  const mod = modifierLabel();
  return [
    { keys: [mod, "K"], label: t("commands.openPalette") },
    { keys: [mod, "Shift", "O"], label: t("commands.newConversation") },
    { keys: ["Shift", "Esc"], label: t("commands.focusComposer") },
    { keys: [mod, "Shift", "E"], label: t("commands.toggleRecords") },
    { keys: ["Esc"], label: t("commands.stopGenerating") },
    { keys: [mod, "/"], label: t("commands.shortcuts") },
  ];
}

/**
 * Ctrl/⌘+K: one box to go anywhere — a page, a settings section, a
 * conversation — or to do the common things without reaching for the mouse.
 * Also owns the app-wide shortcuts, so they are defined in one place.
 *
 * The box floats without a scrim and never blocks the page behind it. By
 * default it is transient: it closes when a command runs, when the user
 * clicks or focuses elsewhere, and on Escape, Ctrl/⌘+K or the close button.
 * Pinned — with the pin button, or simply by dragging it aside — it is kept
 * beside the work: commands run without closing it, clicks elsewhere leave it
 * in place (dimmed while it lacks focus), and Ctrl/⌘+K brings focus back.
 * Escape, the close button or Ctrl/⌘+K while it has focus still dismiss it.
 */
export function CommandPalette({ pages }: { pages: PalettePage[] }) {
  useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const openSettings = useOpenSettings();
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Rows with the search they answer, so a slower earlier search never shows under a newer query.
  const [conversations, setConversations] = useState<{ search: string; rows: Conversation[] }>({ search: "", rows: [] });
  const [models, setModels] = useState<ModelLibraryItem[]>([]);
  const [position, setPosition] = useState<Position | null>(null);
  const [pinned, setPinned] = useState(false);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Where focus was when the box opened, and whether it was dismissed by clicking elsewhere.
  const returnFocus = useRef<HTMLElement | null>(null);
  const leftByClick = useRef(false);

  const changeOpen = useCallback((value: boolean) => {
    setOpen(value);
    if (!value) { setQuery(""); setActive(0); setPosition(null); setPinned(false); }
  }, []);

  // Closed: open. Open but set aside: take focus back. Open with focus: close.
  const summon = useCallback((toggle = true) => {
    if (panel.current && !panel.current.contains(document.activeElement)) { input.current?.focus(); input.current?.select(); }
    else if (!panel.current) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      leftByClick.current = false;
      changeOpen(true);
    }
    else if (toggle) changeOpen(false);
  }, [changeOpen]);

  const chat = useCallback((command: ChatCommand) => sendChatCommand(command, { onChatPage: pathname === "/chat", navigate: href => router.push(href) }), [pathname, router]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (withModifier(event) && !event.shiftKey && key === "k") { event.preventDefault(); summon(); return; }
      if (withModifier(event) && !event.shiftKey && key === "/") { event.preventDefault(); setHelp(value => !value); return; }
      if (withModifier(event) && event.shiftKey && key === "o") { event.preventDefault(); chat({ type: "new-conversation" }); return; }
      if (withModifier(event) && event.shiftKey && key === "e") { event.preventDefault(); chat({ type: "toggle-records" }); return; }
      if (event.shiftKey && key === "escape" && !withModifier(event)) { event.preventDefault(); chat({ type: "focus-composer" }); }
    };
    const onOpen = () => summon(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(OPEN_EVENT, onOpen); };
  }, [chat, summon]);

  // A moved box stays whole inside a window that shrinks.
  useEffect(() => {
    if (!position) return;
    const keep = () => setPosition(old => old && panel.current ? clampToWindow(old.left, old.top, panel.current.offsetWidth, panel.current.offsetHeight) : old);
    window.addEventListener("resize", keep);
    return () => window.removeEventListener("resize", keep);
  }, [position]);

  function startDrag(event: ReactPointerEvent<HTMLElement>) {
    const node = panel.current;
    if (event.button !== 0 || !node || (event.target as HTMLElement).closest("input, button")) return;
    // Keeps the caret in the search box while the box is carried.
    event.preventDefault();
    input.current?.focus();
    const box = node.getBoundingClientRect();
    const from = { x: event.clientX, y: event.clientY };
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      // Carrying it aside says it should stay there.
      setPinned(true);
      setPosition(clampToWindow(box.left + next.clientX - from.x, box.top + next.clientY - from.y, box.width, box.height));
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  // The chat models in the library, read each time the palette opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/models", { cache: "no-store" }).then(response => response.ok ? response.json() : null)
      .then((payload: { data?: { library?: ModelLibraryItem[] } } | null) => { if (!cancelled) setModels((payload?.data?.library ?? []).filter(model => model.modes.includes("chat"))); })
      .catch(() => { if (!cancelled) setModels([]); });
    return () => { cancelled = true; };
  }, [open]);

  // Recent conversations until two characters are typed, then a search of titles and messages.
  // The service searches from two characters, so a single one filters the recent titles here.
  const search = conversationSearch(query);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      conversationsApi.list({ q: search, tag: "", state: "active" })
        .then(page => { if (!cancelled) setConversations({ search, rows: page.data }); })
        .catch(() => { if (!cancelled) setConversations({ search, rows: [] }); });
    }, search ? 150 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, search]);

  const items = useMemo(() => {
    // A pinned box stays for the next command; a transient one is done.
    const close = (action: () => void) => () => {
      if (pinned) { setQuery(""); setActive(0); } else changeOpen(false);
      action();
    };
    const mod = modifierLabel();
    const all: Item[] = [
      { id: "new", group: t("commands.group.actions"), label: t("commands.newConversation"), icon: MessageSquarePlus, hint: `${mod} Shift O`, run: close(() => chat({ type: "new-conversation" })) },
      { id: "focus", group: t("commands.group.actions"), label: t("commands.focusComposer"), icon: TextCursorInput, hint: "Shift Esc", run: close(() => chat({ type: "focus-composer" })) },
      { id: "records", group: t("commands.group.actions"), label: t("commands.toggleRecords"), icon: PanelRight, hint: `${mod} Shift E`, run: close(() => chat({ type: "toggle-records" })) },
      { id: "help", group: t("commands.group.actions"), label: t("commands.shortcuts"), icon: Keyboard, hint: `${mod} /`, run: close(() => setHelp(true)) },
      ...pages.map(page => ({ id: `page:${page.href}`, group: t("commands.group.pages"), label: page.label, icon: page.icon, run: close(() => router.push(page.href)) })),
      ...models.map(model => ({ id: `model:${modelRefKey(model)}`, group: t("commands.group.models"), label: model.name, icon: Cpu, run: close(() => chat({ type: "select-model", model: modelRefKey(model) })) })),
      ...settingsSections().map(section => ({ id: `settings:${section.id}`, group: t("commands.group.settings"), label: section.label, icon: Settings2, run: close(() => openSettings(section.id)) })),
    ];
    const text = query.trim().toLowerCase();
    const matching = text ? all.filter(item => item.label.toLowerCase().includes(text)) : all;
    const rows = conversations.search === search ? conversations.rows : [];
    const shown = search || !text ? rows : rows.filter(conversation => conversation.title.toLowerCase().includes(text));
    const found: Item[] = shown.slice(0, 8).map(conversation => ({ id: `chat:${conversation.id}`, group: t("commands.group.conversations"), label: conversation.title, icon: MessagesSquare, run: close(() => chat({ type: "open-conversation", id: conversation.id })) }));
    return [...matching, ...found];
  }, [chat, changeOpen, conversations, models, openSettings, pages, pinned, query, router, search]);

  const current = Math.min(active, Math.max(items.length - 1, 0));
  useEffect(() => { list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" }); }, [current]);

  return <>
    <Dialog.Root open={open} onOpenChange={changeOpen} modal={false}>
      <Dialog.Portal>
        <Dialog.Content
          ref={panel} className="command-palette" aria-describedby={undefined}
          data-moved={position ? true : undefined} data-pinned={pinned || undefined}
          style={position ? { left: position.left, top: position.top, translate: "none" } : undefined}
          // Only a click elsewhere means leaving. Focus that a page moves on its
          // own (a composer focusing itself after navigation) or a Tab out does not.
          onFocusOutside={event => event.preventDefault()}
          onPointerDownOutside={event => {
            if (pinned || (event.target as HTMLElement | null)?.closest(`[${PALETTE_TRIGGER}]`)) event.preventDefault();
            else leftByClick.current = true;
          }}
          // Without a modal focus trap nothing returns focus on its own: closing
          // from the box goes back to where the user was, while a click elsewhere
          // leaves focus where that click put it.
          onCloseAutoFocus={event => {
            event.preventDefault();
            const target = returnFocus.current;
            returnFocus.current = null;
            if (!leftByClick.current && target?.isConnected && !target.closest(".command-palette")) target.focus();
          }}
          // Escape belongs to whatever has focus; elsewhere it stops a reply.
          onEscapeKeyDown={event => { if (!panel.current?.contains(document.activeElement)) event.preventDefault(); }}
        >
          <Dialog.Title className="sr-only">{t("commands.label")}</Dialog.Title>
          <label className="command-palette-search" onPointerDown={startDrag}>
            <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={input}
              role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list" aria-label={t("commands.label")}
              aria-activedescendant={items.length ? `${listId}-${current}` : undefined}
              placeholder={t("commands.placeholder")} value={query} autoFocus
              onChange={event => { setQuery(event.target.value); setActive(0); }}
              onKeyDown={event => {
                if (event.key === "ArrowDown") { event.preventDefault(); setActive((current + 1) % Math.max(items.length, 1)); }
                else if (event.key === "ArrowUp") { event.preventDefault(); setActive((current - 1 + items.length) % Math.max(items.length, 1)); }
                else if (event.key === "Enter" && items[current]) { event.preventDefault(); items[current].run(); }
              }}
            />
            <button type="button" className="command-palette-close" aria-pressed={pinned} aria-label={t("commands.pin")} title={t(pinned ? "commands.unpin" : "commands.pin")} onClick={() => setPinned(value => !value)}><Pin aria-hidden="true" className="size-3.5" /></button>
            <Dialog.Close className="command-palette-close" aria-label={t("commands.close")} title={t("commands.close")}><X aria-hidden="true" className="size-4" /></Dialog.Close>
          </label>
          <div ref={list} id={listId} role="listbox" aria-label={t("commands.label")} className="command-palette-list">
            {items.length ? items.map((item, index) => <Fragment key={item.id} group={index === 0 || items[index - 1].group !== item.group ? item.group : null}>
              <div id={`${listId}-${index}`} role="option" aria-selected={index === current} data-index={index}
                className={cn("command-palette-item", index === current && "is-active")}
                onPointerMove={() => { if (index !== current) setActive(index); }}
                onClick={item.run}>
                <item.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint ? <kbd className="command-palette-hint">{item.hint}</kbd> : index === current ? <CornerDownLeft aria-hidden="true" className="size-3.5 text-muted-foreground" /> : null}
              </div>
            </Fragment>) : <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("commands.empty")}</p>}
          </div>
          <div className="command-palette-footer" onPointerDown={startDrag} title={t("commands.drag")}>
            <span className="inline-flex min-w-0 items-center gap-1.5 truncate">{pinned ? <Pin aria-hidden="true" className="size-3 shrink-0" /> : <GripHorizontal aria-hidden="true" className="size-3.5 shrink-0" />}{t(pinned ? "commands.pinnedHint" : "commands.dragHint")}</span>
            <span className="ml-auto flex shrink-0 items-center gap-3">
              <span><kbd className="command-palette-hint">↑↓</kbd> {t("commands.hint.select")}</span>
              <span><kbd className="command-palette-hint">↵</kbd> {t("commands.hint.run")}</span>
              <span><kbd className="command-palette-hint">Esc</kbd> {t("commands.hint.close")}</span>
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    <Dialog.Root open={help} onOpenChange={setHelp} modal={false}>
      <Dialog.Portal>
        <Dialog.Content className="command-palette command-palette-help" aria-describedby={undefined}>
          <Dialog.Title className="px-4 pb-2 pt-4 text-sm font-semibold">{t("commands.shortcuts")}</Dialog.Title>
          <dl className="flex flex-col px-2 pb-3">
            {shortcutList().map(shortcut => <div key={shortcut.label} className="flex items-center justify-between gap-4 rounded-[--radius-inner] px-2 py-2 text-sm">
              <dt className="text-muted-foreground">{shortcut.label}</dt>
              <dd className="flex shrink-0 gap-1">{shortcut.keys.map(key => <kbd key={key} className="command-palette-hint">{key}</kbd>)}</dd>
            </div>)}
          </dl>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}

/** The service's conversation search: two characters or more, otherwise none. */
function conversationSearch(query: string) {
  const text = query.trim();
  return Array.from(text).length >= 2 ? text : "";
}

/** A group heading before the first item of each group. */
function Fragment({ group, children }: { group: string | null; children: React.ReactNode }) {
  return <>{group ? <div role="presentation" className="command-palette-group">{group}</div> : null}{children}</>;
}
