"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType } from "react";
import { usePathname, useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { CornerDownLeft, Cpu, Keyboard, MessageSquarePlus, MessagesSquare, PanelRight, Search, Settings2, TextCursorInput } from "lucide-react";
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
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [models, setModels] = useState<ModelLibraryItem[]>([]);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);

  const chat = useCallback((command: ChatCommand) => sendChatCommand(command, { onChatPage: pathname === "/chat", navigate: href => router.push(href) }), [pathname, router]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (withModifier(event) && !event.shiftKey && key === "k") { event.preventDefault(); setOpen(value => !value); return; }
      if (withModifier(event) && !event.shiftKey && key === "/") { event.preventDefault(); setHelp(value => !value); return; }
      if (withModifier(event) && event.shiftKey && key === "o") { event.preventDefault(); chat({ type: "new-conversation" }); return; }
      if (withModifier(event) && event.shiftKey && key === "e") { event.preventDefault(); chat({ type: "toggle-records" }); return; }
      if (event.shiftKey && key === "escape" && !withModifier(event)) { event.preventDefault(); chat({ type: "focus-composer" }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chat]);

  // The chat models in the library, read each time the palette opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/models", { cache: "no-store" }).then(response => response.ok ? response.json() : null)
      .then((payload: { data?: { library?: ModelLibraryItem[] } } | null) => { if (!cancelled) setModels((payload?.data?.library ?? []).filter(model => model.modes.includes("chat"))); })
      .catch(() => { if (!cancelled) setModels([]); });
    return () => { cancelled = true; };
  }, [open]);

  // Recent conversations while the box is empty; a search once two characters are typed.
  useEffect(() => {
    if (!open) return;
    const text = query.trim();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      conversationsApi.list({ q: text.length >= 2 ? text : "", tag: "", state: "active" })
        .then(page => { if (!cancelled) setConversations(page.data.slice(0, 8)); })
        .catch(() => { if (!cancelled) setConversations([]); });
    }, text ? 150 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, query]);

  const items = useMemo(() => {
    const close = (action: () => void) => () => { setOpen(false); setQuery(""); setActive(0); action(); };
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
    const found: Item[] = conversations.map(conversation => ({ id: `chat:${conversation.id}`, group: t("commands.group.conversations"), label: conversation.title, icon: MessagesSquare, run: close(() => chat({ type: "open-conversation", id: conversation.id })) }));
    return [...matching, ...found];
  }, [chat, conversations, models, openSettings, pages, query, router]);

  const current = Math.min(active, Math.max(items.length - 1, 0));
  useEffect(() => { list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" }); }, [current]);

  return <>
    <Dialog.Root open={open} onOpenChange={value => { setOpen(value); if (!value) { setQuery(""); setActive(0); } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="command-palette-overlay" />
        <Dialog.Content className="command-palette" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">{t("commands.label")}</Dialog.Title>
          <label className="command-palette-search">
            <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <input
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    <Dialog.Root open={help} onOpenChange={setHelp}>
      <Dialog.Portal>
        <Dialog.Overlay className="command-palette-overlay" />
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

/** A group heading before the first item of each group. */
function Fragment({ group, children }: { group: string | null; children: React.ReactNode }) {
  return <>{group ? <div role="presentation" className="command-palette-group">{group}</div> : null}{children}</>;
}
