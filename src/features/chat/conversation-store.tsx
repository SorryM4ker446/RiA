"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { chatApi } from "@/features/chat/api-client";
import type { ChatSummary } from "@/features/chat/page-utils";
import { t } from "@/lib/locale";
import { animateRemoval } from "@/lib/ui/removal";
import { useRefreshOnReturn } from "@/lib/use-refresh-on-return";

/*
 * The conversations the app lists, in one place.
 *
 * The sidebar shows them on every page and the chat page works in one of them,
 * so both read and change the same list: a conversation renamed, pinned,
 * archived or deleted in either is what the other shows next. The list is read
 * from the service page by page; the store keeps what it has read.
 *
 * Besides the stored state, it carries what only this window knows: which
 * conversation the chat page has open, and which one is answering right now.
 *
 * It follows the service's account of what happens to the conversations
 * (/api/conversations/events) rather than asking on a timer: when anything
 * changes, anywhere, the list is read again, and when a turn starts or ends the
 * chat page is told, so it can show an answer it did not ask for.
 */

/** Changes arriving together are read once: a turn ending saves its answer and marks it unread at nearly the same moment. */
const COALESCE_MS = 120;

export type TurnNotice = { type: "turn-started" | "turn-finished"; chatId: string; source: "chat" | "task"; outcome?: string; title?: string | null };

export type ReloadOutcome = { status: "read"; list: ChatSummary[] } | { status: "superseded" } | { status: "failed"; message: string };

type Store = {
  chats: ChatSummary[];
  setChats: Dispatch<SetStateAction<ChatSummary[]>>;
  /** Until the list has been read once. Reading it again keeps showing what it has. */
  isLoading: boolean;
  nextCursor: string | null;
  isLoadingMore: boolean;
  /**
   * Reads the first page again. `include` is a conversation to keep in the list
   * even when it is not on that page (the one the chat page has open), unless it
   * is gone or archived. A `background` read (a refresh nobody asked for) steps
   * aside while another read is under way instead of making it stale.
   */
  reload: (options?: { include?: string | null; background?: boolean }) => Promise<ReloadOutcome>;
  /** Counts the reads that landed, so a page can act on each new list whoever asked for it. */
  readVersion: number;
  loadMore: () => Promise<string | null>;
  /** Makes reads already under way stale: they started before a change and must not land after it. */
  invalidate: () => void;
  /** Replaces one conversation with what the service returned for it. */
  update: (chat: ChatSummary) => void;
  /** Takes a conversation out of the list (deleted or archived) and tells whoever has it open. */
  remove: (id: string) => Promise<void>;
  /** `remaining` is the list without it, for a page that has to open another. */
  onRemoved: (listener: (id: string, remaining: ChatSummary[]) => void) => () => void;
  /**
   * Hears that the service changed conversations or tasks (a run starting or
   * ending, a task edited elsewhere), as the service says it, and again on
   * reconnecting, when something may have been missed.
   */
  onChanged: (listener: () => void) => () => void;
  /** The conversation the chat page has open, and the one answering in this window. */
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  workingId: string | null;
  setWorkingId: (id: string | null) => void;
  /** While the chat page creates a conversation, so a second click cannot ask for another. */
  isCreating: boolean;
  setCreating: (creating: boolean) => void;
  /** Hears a turn start or end in any conversation, whoever started it. */
  onTurn: (listener: (notice: TurnNotice) => void) => () => void;
};

const ConversationStoreContext = createContext<Store | null>(null);

export function ConversationStoreProvider({ children }: { children: ReactNode }) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [isCreating, setCreating] = useState(false);
  const [readVersion, setReadVersion] = useState(0);
  const request = useRef(0);
  const inFlight = useRef(0);
  const activeIdRef = useRef(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  const loadingMore = useRef(false);
  const cursorRef = useRef<string | null>(null);
  const removedListeners = useRef(new Set<(id: string, remaining: ChatSummary[]) => void>());
  const chatsRef = useRef(chats);
  useEffect(() => { chatsRef.current = chats; }, [chats]);
  const turnListeners = useRef(new Set<(notice: TurnNotice) => void>());
  const changedListeners = useRef(new Set<() => void>());
  // A change heard while a read is under way is read after it, not dropped.
  const readAgain = useRef(false);

  const invalidate = useCallback(() => { request.current += 1; }, []);

  const reload = useCallback(async ({ include = null, background = false }: { include?: string | null; background?: boolean } = {}): Promise<ReloadOutcome> => {
    if (background && inFlight.current > 0) return { status: "superseded" };
    const id = ++request.current;
    inFlight.current += 1;
    loadingMore.current = false;
    setIsLoadingMore(false);
    try {
      const payload = await chatApi.listConversations();
      const list = payload.data ?? [];
      if (include && !list.some(chat => chat.id === include)) {
        const kept = await chatApi.getConversation(include);
        if (kept.data && !kept.data.archived) list.push(kept.data);
      }
      if (id !== request.current) return { status: "superseded" };
      setChats(list);
      cursorRef.current = payload.pageInfo?.nextCursor ?? null;
      setNextCursor(cursorRef.current);
      setIsLoading(false);
      setReadVersion(version => version + 1);
      return { status: "read", list };
    } catch (error) {
      if (id !== request.current) return { status: "superseded" };
      // A list that could not be read cannot disprove anything; it stays as it was.
      setIsLoading(false);
      return { status: "failed", message: error instanceof Error ? error.message : t("chatApi.listConversationsFailed") };
    } finally {
      inFlight.current -= 1;
      if (inFlight.current === 0 && readAgain.current) {
        readAgain.current = false;
        void reloadRef.current({ include: activeIdRef.current, background: true });
      }
    }
  }, []);
  const reloadRef = useRef(reload);
  useEffect(() => { reloadRef.current = reload; }, [reload]);

  const loadMore = useCallback(async (): Promise<string | null> => {
    const cursor = cursorRef.current;
    if (!cursor || loadingMore.current) return null;
    const id = request.current;
    loadingMore.current = true;
    setIsLoadingMore(true);
    try {
      const page = await chatApi.listConversations(cursor);
      if (id !== request.current) return null;
      setChats(current => [...current, ...page.data.filter(chat => !current.some(item => item.id === chat.id))]);
      cursorRef.current = page.pageInfo?.nextCursor ?? null;
      setNextCursor(cursorRef.current);
      return null;
    } catch (error) {
      return id === request.current ? (error instanceof Error ? error.message : t("conversationsHook.loadMoreFailed")) : null;
    } finally {
      if (id === request.current) { loadingMore.current = false; setIsLoadingMore(false); }
    }
  }, []);

  const update = useCallback((chat: ChatSummary) => setChats(current => current.map(item => item.id === chat.id ? chat : item)), []);

  const remove = useCallback(async (id: string) => {
    request.current += 1;
    loadingMore.current = false;
    setIsLoadingMore(false);
    // The row folds away wherever it is shown before it leaves the list.
    const remaining = chatsRef.current.filter(chat => chat.id !== id);
    await animateRemoval(id, () => setChats(current => current.filter(chat => chat.id !== id)));
    for (const listener of removedListeners.current) listener(id, remaining);
  }, []);

  const onRemoved = useCallback((listener: (id: string, remaining: ChatSummary[]) => void) => {
    removedListeners.current.add(listener);
    return () => { removedListeners.current.delete(listener); };
  }, []);

  const onChanged = useCallback((listener: () => void) => {
    changedListeners.current.add(listener);
    return () => { changedListeners.current.delete(listener); };
  }, []);

  const onTurn = useCallback((listener: (notice: TurnNotice) => void) => {
    turnListeners.current.add(listener);
    return () => { turnListeners.current.delete(listener); };
  }, []);

  // The list is read when the app opens, and again when the window comes back
  // into view. A page below that reads the list on mount (chat) has already
  // asked by the time this runs; only a page that does not leaves the first read to the store.
  useEffect(() => { if (request.current === 0) void reload({ background: true }); }, [reload]);
  useRefreshOnReturn(() => { void reload({ include: activeIdRef.current, background: true }); });
  // Whatever changes the conversations elsewhere (a task, another window, the
  // service finishing an answer) is heard here and read again. The browser
  // reconnects a dropped connection by itself; `ready` on each connection reads
  // the list again, so nothing said while it was away is missed.
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/conversations/events");
    let timer = 0;
    const readSoon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (inFlight.current > 0) { readAgain.current = true; return; }
        void reloadRef.current({ include: activeIdRef.current, background: true });
      }, COALESCE_MS);
    };
    // The first connection's `ready` comes while the page's own first read is under way.
    let connected = false;
    const tellChanged = () => {
      for (const listener of changedListeners.current) {
        try { listener(); } catch { /* One listener failing does not keep the others from hearing it. */ }
      }
    };
    source.addEventListener("ready", () => { if (connected) { readSoon(); tellChanged(); } connected = true; });
    source.addEventListener("changed", () => { readSoon(); tellChanged(); });
    source.addEventListener("turn", event => {
      let notice: TurnNotice;
      try { notice = JSON.parse((event as MessageEvent<string>).data); } catch { return; }
      readSoon();
      for (const listener of turnListeners.current) {
        try { listener(notice); } catch { /* One listener failing does not keep the others from hearing it. */ }
      }
    });
    return () => { window.clearTimeout(timer); source.close(); };
  }, []);

  const value = useMemo<Store>(() => ({
    chats, setChats, isLoading, nextCursor, isLoadingMore, reload, readVersion, loadMore, invalidate, update, remove, onRemoved, onChanged,
    activeId, setActiveId, workingId, setWorkingId, isCreating, setCreating, onTurn,
  }), [chats, isLoading, nextCursor, isLoadingMore, reload, readVersion, loadMore, invalidate, update, remove, onRemoved, onChanged, activeId, workingId, isCreating, onTurn]);
  return <ConversationStoreContext.Provider value={value}>{children}</ConversationStoreContext.Provider>;
}

export function useConversationStore(): Store {
  const store = useContext(ConversationStoreContext);
  if (!store) throw new Error("useConversationStore must be used inside ConversationStoreProvider");
  return store;
}

/**
 * What a conversation's dot says: an answer waiting for its turn, its task running, an answer being written in
 * it (here, in another window or by a task), an approval waiting, or an answer
 * not opened yet. The conversation open on the chat page is being read, so it
 * is never unread.
 */
export type ConversationState = "queued" | "working" | "task" | "approval" | "unread" | null;

export function conversationState(chat: ChatSummary, workingId: string | null, activeId: string | null = null): ConversationState {
  // Waiting for a place to answer: it starts by itself once one frees up.
  if (chat.queued) return "queued";
  if (chat.task?.running) return "task";
  if (chat.id === workingId || chat.answering) return "working";
  if (chat.awaitingApproval) return "approval";
  return chat.unread && chat.id !== activeId ? "unread" : null;
}
