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
 */

/** How often the list is read again while the window is in view; sooner while a task runs in one of them. */
const REFRESH_MS = 30_000;
const TASK_REFRESH_MS = 5_000;

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
  /** The conversation the chat page has open, and the one answering in this window. */
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  workingId: string | null;
  setWorkingId: (id: string | null) => void;
  /** While the chat page creates a conversation, so a second click cannot ask for another. */
  isCreating: boolean;
  setCreating: (creating: boolean) => void;
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
    }
  }, []);

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

  // The list is read when the app opens, and again when the window comes back
  // into view. A conversation can change without this window doing anything (a
  // task runs in it, another window answers), so the list is also read again on
  // a timer while the window is visible, sooner while a task is running.
  // A page below that reads the list on mount (chat) has already asked by the
  // time this runs; only a page that does not leaves the first read to the store.
  useEffect(() => { if (request.current === 0) void reload({ background: true }); }, [reload]);
  useRefreshOnReturn(() => { void reload({ include: activeIdRef.current, background: true }); });
  const taskRunning = chats.some(chat => chat.task?.running);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload({ include: activeIdRef.current, background: true });
    }, taskRunning ? TASK_REFRESH_MS : REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload, taskRunning]);

  const value = useMemo<Store>(() => ({
    chats, setChats, isLoading, nextCursor, isLoadingMore, reload, readVersion, loadMore, invalidate, update, remove, onRemoved,
    activeId, setActiveId, workingId, setWorkingId, isCreating, setCreating,
  }), [chats, isLoading, nextCursor, isLoadingMore, reload, readVersion, loadMore, invalidate, update, remove, onRemoved, activeId, workingId, isCreating]);
  return <ConversationStoreContext.Provider value={value}>{children}</ConversationStoreContext.Provider>;
}

export function useConversationStore(): Store {
  const store = useContext(ConversationStoreContext);
  if (!store) throw new Error("useConversationStore must be used inside ConversationStoreProvider");
  return store;
}

/** What a conversation's dot says: answering in this window, a task running in it, or an approval waiting. */
export type ConversationState = "working" | "task" | "approval" | null;

export function conversationState(chat: ChatSummary, workingId: string | null): ConversationState {
  if (chat.id === workingId) return "working";
  if (chat.task?.running) return "task";
  return chat.awaitingApproval ? "approval" : null;
}
