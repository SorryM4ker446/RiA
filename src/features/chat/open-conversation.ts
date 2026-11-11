import { LAST_ACTIVE_CHAT_STORAGE_KEY } from "@/features/chat/types";

/*
 * Opening one particular conversation from elsewhere: a task's row, a notice,
 * a system notification.
 *
 * Chat already opens the conversation it remembers as the last active one, so
 * that is the one mechanism used here: the conversation is remembered, and a
 * chat page already on screen is told to switch to it. `/chat?conversationId=`
 * is the address for it, read once when chat opens.
 */

export const OPEN_CONVERSATION_EVENT = "ria:open-conversation";
export const CONVERSATION_PARAM = "conversationId";

const IDENTIFIER = /^[a-zA-Z0-9_-]{1,200}$/;

/** The conversation an in-app address opens, if it names one. */
export function conversationIdOf(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, "http://app.invalid");
    if (url.origin !== "http://app.invalid" || url.pathname !== "/chat") return null;
    const id = url.searchParams.get(CONVERSATION_PARAM);
    return id && IDENTIFIER.test(id) ? id : null;
  } catch { return null; }
}

/** The address that opens a conversation. */
export const conversationHref = (id: string) => `/chat?${CONVERSATION_PARAM}=${encodeURIComponent(id)}`;

/**
 * Makes the conversation the one chat opens, and switches a chat page already
 * showing. Returns whether the address named a conversation at all.
 */
export function openConversationFromHref(href: string | null | undefined): boolean {
  const id = conversationIdOf(href);
  if (!id) return false;
  try { window.localStorage.setItem(LAST_ACTIVE_CHAT_STORAGE_KEY, id); } catch { /* The event below still switches an open chat. */ }
  window.dispatchEvent(new CustomEvent<string>(OPEN_CONVERSATION_EVENT, { detail: id }));
  return true;
}

/**
 * The conversation the current address asks for, taken out of the address so a
 * reload or a later visit does not keep forcing it.
 */
export function takeRequestedConversation(): string | null {
  const id = conversationIdOf(`${window.location.pathname}${window.location.search}`);
  if (!id) return null;
  const url = new URL(window.location.href);
  url.searchParams.delete(CONVERSATION_PARAM);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return id;
}
