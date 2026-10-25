"use client";

import { useEffect, useRef } from "react";

/**
 * Things the command palette and keyboard shortcuts ask of the chat page. The
 * page owns the conversation state, so a command is handed to it rather than
 * carried out elsewhere: on the chat page at once, from any other page after
 * navigating there (kept for the page to pick up once it is ready).
 */
export type ChatCommand =
  | { type: "new-conversation" }
  | { type: "open-conversation"; id: string }
  | { type: "focus-composer" }
  | { type: "toggle-records" }
  | { type: "select-model"; model: string };

const EVENT = "ria:chat-command";
const PENDING = "ria:pending-chat-command";

export function sendChatCommand(command: ChatCommand, { onChatPage, navigate }: { onChatPage: boolean; navigate: (href: string) => void }) {
  if (onChatPage) { window.dispatchEvent(new CustomEvent<ChatCommand>(EVENT, { detail: command })); return; }
  try { sessionStorage.setItem(PENDING, JSON.stringify(command)); } catch { /* The command is lost; the page still opens. */ }
  navigate("/chat");
}

/** Runs chat commands on the chat page; one left by another page runs once the page is ready. */
export function useChatCommands(run: (command: ChatCommand) => void, ready: boolean) {
  const handler = useRef(run);
  useEffect(() => { handler.current = run; });
  useEffect(() => {
    const listen = (event: Event) => handler.current((event as CustomEvent<ChatCommand>).detail);
    window.addEventListener(EVENT, listen);
    return () => window.removeEventListener(EVENT, listen);
  }, []);
  useEffect(() => {
    if (!ready) return;
    let pending: string | null = null;
    try { pending = sessionStorage.getItem(PENDING); sessionStorage.removeItem(PENDING); } catch { return; }
    if (!pending) return;
    try { handler.current(JSON.parse(pending) as ChatCommand); } catch { /* A malformed leftover is dropped. */ }
  }, [ready]);
}
