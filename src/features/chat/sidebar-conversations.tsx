"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Archive, CalendarClock, ChevronDown, ChevronRight, Loader2, MoreHorizontal, PencilLine, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { chatApi } from "@/features/chat/api-client";
import { conversationState, useConversationStore, type ConversationState } from "@/features/chat/conversation-store";
import { conversationHref, openConversationFromHref } from "@/features/chat/open-conversation";
import type { ChatSummary } from "@/features/chat/page-utils";
import { sendChatCommand } from "@/features/commands/chat-commands";
import { t, tf } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { removalKey } from "@/lib/ui/removal";

/*
 * The conversations in the sidebar, on every page.
 *
 * Laid out as Claude Code lays out its sessions: what is pinned first, then the
 * conversations scheduled tasks write into, then every other conversation; each
 * group most recently active first. A quiet header names the list and starts a new
 * conversation; each row is one line, its title, with a dot at its end when it
 * needs attention, which gives way to its menu when the row is pointed at.
 * More rows are read as the list is scrolled.
 */

type FoldKey = "pinned" | "tasks";
const COLLAPSED_KEY = "sidebar:collapsed-sections";

/**
 * Most recently active first, the order the service pages the list in. A
 * conversation kept in the list from beyond the first page, or one that has
 * just been answered, takes its place by the same rule.
 */
const byActivity = (chats: ChatSummary[]) => [...chats].sort((a, b) =>
  Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

function readCollapsed(): Set<FoldKey> {
  try { return new Set(JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]")); } catch { return new Set(); }
}

/**
 * Which edges of a scrolling list have more beyond them, so they can fade
 * instead of cutting a row in half. Measured on scroll and whenever the list or
 * its content changes size.
 */
function useScrollEdges() {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState("");
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => {
      const above = node.scrollTop > 1;
      const below = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
      setEdges([above && "top", below && "bottom"].filter(Boolean).join(" "));
    };
    node.addEventListener("scroll", measure, { passive: true });
    // A ResizeObserver reports once when it starts watching, which takes the first measurement.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (content.current) observer.observe(content.current);
    return () => { node.removeEventListener("scroll", measure); observer.disconnect(); };
  }, []);
  return { scroller, content, edges };
}

export function SidebarConversations() {
  useLocale();
  const store = useConversationStore();
  const { chats, activeId, workingId, isLoading, nextCursor, isLoadingMore, isCreating } = store;
  const pathname = usePathname();
  const router = useRouter();
  const onChatPage = pathname === "/chat";
  const [collapsed, setCollapsed] = useState<Set<FoldKey>>(() => new Set());
  // Browser storage is read after mount, so the server render and the first client render agree.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setCollapsed(readCollapsed()); }, []);
  const toggle = (key: FoldKey) => setCollapsed(current => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    try { window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* Folding still applies for this visit. */ }
    return next;
  });
  const { scroller, content, edges } = useScrollEdges();

  // More rows are read once the end of the list comes into view.
  const end = useRef<HTMLDivElement>(null);
  const { loadMore } = store;
  useEffect(() => {
    const node = end.current;
    if (!node || !nextCursor) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) void loadMore(); });
    observer.observe(node);
    return () => observer.disconnect();
  }, [nextCursor, loadMore]);

  const open = (id: string) => {
    openConversationFromHref(conversationHref(id));
    if (!onChatPage) router.push("/chat");
  };
  const newChat = () => sendChatCommand({ type: "new-conversation" }, { onChatPage, navigate: href => router.push(href) });

  const sorted = byActivity(chats);
  const pinned = sorted.filter(chat => chat.pinned);
  const tasks = sorted.filter(chat => !chat.pinned && chat.task);
  const others = sorted.filter(chat => !chat.pinned && !chat.task);
  const rows = (list: ChatSummary[]) => <Rows chats={list} activeId={activeId} workingId={workingId} onOpen={open} />;
  const fold = (key: FoldKey) => ({ folded: collapsed.has(key), onToggle: () => toggle(key) });

  return (
    // Only the list scrolls: the navigation above, and the header and the way to
    // every conversation around it, stay where they are.
    <aside className="sidebar-chats" aria-label={t("chat.conversations.title")}>
      <div className="sidebar-chats-header">
        <span className="sidebar-chats-title">{t("sidebar.conversations")}</span>
        <Button type="button" variant="ghost" size="icon-sm" className="sidebar-chats-new" aria-label={t("sidebar.newChat")} title={t("sidebar.newChat")} disabled={isCreating} onClick={newChat}>
          {isCreating ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Plus aria-hidden="true" />}
        </Button>
      </div>
      <div ref={scroller} className="sidebar-chats-scroll" data-edges={edges || undefined}>
        <div ref={content} className="flex flex-col gap-3">
          {pinned.length ? <Group label={t("chat.conversations.pinned")} {...fold("pinned")}>{rows(pinned)}</Group> : null}
          {tasks.length ? <Group label={t("sidebar.tasks")} {...fold("tasks")}>{rows(tasks)}</Group> : null}
          {/* The rest needs a name only to set it apart from a group above it. */}
          {others.length ? <Group label={t("sidebar.recent")} hideLabel={!pinned.length && !tasks.length}>{rows(others)}</Group> : null}
          {!chats.length && !isLoading ? <p className="sidebar-chat-empty">{t("sidebar.empty")}</p> : null}
          {nextCursor ? <div ref={end} className="sidebar-chat-more" aria-live="polite">
            {isLoadingMore ? <><Loader2 aria-hidden="true" className="size-3 animate-spin" />{t("chat.conversations.loadingMore")}</> : null}
          </div> : null}
        </div>
      </div>
      <Link href="/conversations" className="sidebar-chat-manage" aria-current={pathname === "/conversations" ? "page" : undefined}>
        <span>{t("chat.conversations.manageAll")}</span>
        <ChevronRight aria-hidden="true" className="size-3" />
      </Link>
    </aside>
  );
}

/** A labelled group of rows. Given `onToggle`, its label folds it away, easing closed. */
function Group({ label, hideLabel = false, folded = false, onToggle, children }: { label: string; hideLabel?: boolean; folded?: boolean; onToggle?: () => void; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col">
      {onToggle ? (
        <button type="button" className="sidebar-chat-label" data-foldable="" aria-expanded={!folded} onClick={onToggle}>
          <span>{label}</span>
          <ChevronDown aria-hidden="true" className="size-3" />
        </button>
      ) : hideLabel ? null : <p className="sidebar-chat-label">{label}</p>}
      {/* Kept in place while folded, so it can ease shut and open again. */}
      <div className="sidebar-chat-fold" data-folded={folded || undefined} inert={folded || undefined} aria-hidden={folded || undefined}>
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </section>
  );
}

const STATE_LABEL: Record<Exclude<ConversationState, null>, string> = { queued: "sidebar.state.queued", working: "sidebar.state.working", task: "sidebar.state.task", approval: "sidebar.state.approval", unread: "sidebar.state.unread" };

function Rows({ chats, activeId, workingId, onOpen }: { chats: ChatSummary[]; activeId: string | null; workingId: string | null; onOpen: (id: string) => void }) {
  return <ul className="flex flex-col gap-px">{chats.map(chat => <Row key={chat.id} chat={chat} active={chat.id === activeId} state={conversationState(chat, workingId, activeId)} onOpen={onOpen} />)}</ul>;
}

function Row({ chat, active, state, onOpen }: { chat: ChatSummary; active: boolean; state: ConversationState; onOpen: (id: string) => void }) {
  useLocale();
  const store = useConversationStore();
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  const stateLabel = state ? t(STATE_LABEL[state] as Parameters<typeof t>[0]) : null;

  const failed = (cause: unknown) => toast({ title: t("sidebar.failed"), description: cause instanceof Error ? cause.message : undefined });
  async function rename() {
    const title = draft.trim();
    setEditing(false);
    if (!title || title === chat.title) return;
    try { store.update((await chatApi.renameConversation(chat.id, title)).data); } catch (cause) { failed(cause); }
  }
  async function setPinned(pinned: boolean) {
    try { store.update((await chatApi.setPinned(chat.id, pinned)).data); } catch (cause) { failed(cause); }
  }
  async function archive() {
    try {
      await chatApi.setArchived(chat.id, true);
      await store.remove(chat.id);
      toast({ title: t("sidebar.archived"), description: t("sidebar.archivedHint") });
    } catch (cause) { failed(cause); }
  }
  async function remove() {
    if (!await confirm({ title: t("chat.delete.titleChat"), description: t("chat.delete.bodyChat"), action: t("chat.delete.confirm"), destructive: true })) return;
    try { await chatApi.deleteConversation(chat.id); await store.remove(chat.id); } catch (cause) { failed(cause); }
  }
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); void rename(); }
    if (event.key === "Escape") { event.preventDefault(); setDraft(chat.title); setEditing(false); }
  };

  return (
    <li {...removalKey(chat.id)} className="sidebar-chat-row" data-active={active || undefined} data-attention={state ?? undefined}>
      {editing ? (
        <input autoFocus className="sidebar-chat-rename" aria-label={t("chat.conversations.rename")} value={draft}
          onChange={event => setDraft(event.target.value)} onKeyDown={onKey} onBlur={() => void rename()} onFocus={event => event.currentTarget.select()} maxLength={200} />
      ) : (
        <button type="button" className="sidebar-chat-open" aria-current={active ? "true" : undefined}
          onClick={() => onOpen(chat.id)}>
          {/* Cut short, the whole title shows on hover; the end the menu button covers counts as cut. */}
          <span className="sidebar-chat-title truncate" data-tip-reserve="38">{chat.title}</span>
          {/* After the title, so it is heard second; shown before it. */}
          {chat.task ? <CalendarClock aria-label={t("sidebar.taskConversation")} className="sidebar-chat-task" /> : null}
          {stateLabel ? <span className="sr-only">{stateLabel}</span> : null}
          <span aria-hidden="true" className="sidebar-chat-dot" data-state={state ?? undefined} />
        </button>
      )}
      {editing ? null : <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" className="sidebar-chat-actions" aria-label={tf("chat.conversations.actions", { title: chat.title })}>
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4}>
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => { setDraft(chat.title); setEditing(true); }}><PencilLine aria-hidden="true" />{t("chat.conversations.rename")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void setPinned(!chat.pinned)}>{chat.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}{chat.pinned ? t("conversationRow.unpin") : t("conversationRow.pin")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void archive()}><Archive aria-hidden="true" />{t("conversationRow.archive")}</DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem variant="destructive" onSelect={() => void remove()}><Trash2 aria-hidden="true" />{t("chat.common.delete")}</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>}
    </li>
  );
}
