/*
 * "The conversations changed", said to whoever listens: the sidebar of every
 * open window. Whatever writes a conversation, its messages or the task that
 * owns one says so here, so a list shown elsewhere is read again instead of
 * being polled. What changed is not said; the list is read again whole.
 *
 * It lives as long as the service process, like the turns it sits beside.
 */

type Listener = () => void;
const listeners: Set<Listener> = ((globalThis as { __riaConversationListeners?: Set<Listener> }).__riaConversationListeners ??= new Set());

export function announceConversationsChanged() {
  for (const listener of listeners) {
    try { listener(); } catch { /* One listener failing does not keep the others from hearing it. */ }
  }
}

export function onConversationsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
