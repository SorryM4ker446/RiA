import { useChat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage } from "ai";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { ConversationSession, DRAFT_CHAT, openSession, sessionFor } from "@/features/chat/conversation-session";

/**
 * The conversation on screen, as its session (conversation-session).
 *
 * Opening a conversation is choosing its session: one this window kept shows
 * what it showed at once (`reused`), still answering if it was. A session's
 * draft and queue are read from the browser when it is first opened. What was
 * written while no conversation was open moves into the first one opened that
 * has nothing written in it, or into whichever is opened first when it was
 * typed in this visit, so it is neither lost nor left behind to come back later.
 */
export function useActiveSession(activeChatId: string | null, makeTransport: (chatId: string) => ChatTransport<UIMessage>) {
  const key = activeChatId ?? DRAFT_CHAT;
  const { session, reused } = useMemo(
    () => sessionFor(key, () => new ConversationSession(key, makeTransport(key))),
    // The transport is the one current when the conversation's session is made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const chat = useChat({
    chat: session.chat,
    // A fast model sends far more deltas than a screen can show. Rendering at
    // most every 50ms keeps a long transcript from falling behind the stream;
    // the trailing update still delivers the final text.
    experimental_throttle: 50,
  });

  const previous = useRef<ConversationSession | null>(null);
  useEffect(() => {
    openSession(key);
    session.hydrate();
    const from = previous.current;
    previous.current = session;
    if (!from || from === session || from.id !== DRAFT_CHAT || session.id === DRAFT_CHAT) return;
    from.hydrate();
    if (from.hasDraft && (from.draftTypedHere || !session.hasDraft)) {
      const typed = from.draftTypedHere;
      session.setDraft(from.takeDraft(), { typed });
    }
  }, [key, session]);
  // Leaving the chat page leaves every answer to the background, within its bounds.
  useEffect(() => () => openSession(null), []);

  return { session, reused, state, ...chat };
}
