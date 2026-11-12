import { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";

/*
 * The conversations this window has open in memory, one chat client each.
 *
 * Switching away from a conversation that is answering does not stop reading
 * its answer: its client goes on taking the stream in the background, so
 * coming back shows the answer exactly where it has got to, still moving, with
 * nothing to load or replay. A conversation that is not answering is kept as
 * it was last seen, so going back to it is instant too; the page then checks
 * it against what is saved.
 *
 * Both are bounded. Each answer read in the background holds a connection to
 * the service, and a browser allows only a few per host (six, one of which
 * the conversation events already use), so at most BACKGROUND_READERS are
 * read while another conversation is open; past that the one looked at least
 * recently stops being read here and is read again from the service, merged,
 * when it is opened. The service holds every answer either way: leaving one
 * never stops it.
 */

/** Answers read in the background while another conversation is open. */
const BACKGROUND_READERS = 2;
/** Conversations kept as last seen, not answering, for going back to them at once. */
const KEPT_IDLE = 6;
/** The new conversation before it has an id is never kept: it starts empty each time. */
export const DRAFT_CHAT = "draft";

type Entry = { chat: Chat<UIMessage>; seenAt: number };
const kept = new Map<string, Entry>();
let active: string | null = null;
let clock = 0;

export const isAnswering = (chat: Chat<UIMessage>) => chat.status === "submitted" || chat.status === "streaming";

/**
 * The chat client for a conversation, made with `make` when none is kept.
 * `reused` says it was already here: what it shows is what it showed before.
 */
export function chatFor(id: string, make: () => Chat<UIMessage>): { chat: Chat<UIMessage>; reused: boolean } {
  if (id === DRAFT_CHAT) return { chat: make(), reused: false };
  const entry = kept.get(id);
  if (entry) { entry.seenAt = ++clock; return { chat: entry.chat, reused: true }; }
  const chat = make();
  kept.set(id, { chat, seenAt: ++clock });
  return { chat, reused: false };
}

/** The conversation open now (null: none), and whatever the others are kept to. */
export function openChat(id: string | null) {
  active = id === DRAFT_CHAT ? null : id;
  if (active) { const entry = kept.get(active); if (entry) entry.seenAt = ++clock; }
  const others = [...kept.entries()].filter(([key]) => key !== active).sort((a, b) => b[1].seenAt - a[1].seenAt);
  let readers = 0, idle = 0;
  for (const [key, entry] of others) {
    if (isAnswering(entry.chat)) {
      if (++readers <= BACKGROUND_READERS) continue;
      // Stops reading here only; the service goes on with the answer.
      void entry.chat.stop();
      kept.delete(key);
    } else if (++idle > KEPT_IDLE) kept.delete(key);
  }
}

/** The client kept for a conversation, if this window keeps one. */
export function keptChat(id: string): Chat<UIMessage> | undefined {
  return kept.get(id)?.chat;
}

/** A conversation that is gone (deleted, archived): nothing of it is kept. */
export function forgetChat(id: string) {
  const entry = kept.get(id);
  if (!entry) return;
  kept.delete(id);
  if (isAnswering(entry.chat)) void entry.chat.stop();
}

/** For tests and diagnostics: which conversations are kept, and which of them are being read. */
export function keptChats() {
  return [...kept.entries()].map(([id, entry]) => ({ id, answering: isAnswering(entry.chat) }));
}

/**
 * The saved history, with every message that says the same as the one shown
 * kept as that object; the shown list itself when nothing differs.
 */
export function keepUnchanged(shown: UIMessage[], saved: UIMessage[]): UIMessage[] {
  const byId = new Map(shown.map(message => [message.id, message]));
  let changed = shown.length !== saved.length;
  const merged = saved.map((message, index) => {
    const old = byId.get(message.id);
    if (old && JSON.stringify(old) === JSON.stringify(message)) {
      if (shown[index] !== old) changed = true;
      return old;
    }
    changed = true;
    return message;
  });
  return changed ? merged : shown;
}
