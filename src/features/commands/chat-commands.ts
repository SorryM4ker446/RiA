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
  | { type: "select-model"; model: string }
  /** Starts a new conversation and sends this as its first message. */
  | { type: "ask"; text: string };

const EVENT = "ria:chat-command";
const PENDING = "ria:pending-chat-command";

export function sendChatCommand(command: ChatCommand, { onChatPage, navigate }: { onChatPage: boolean; navigate: (href: string) => void }) {
  if (onChatPage) { window.dispatchEvent(new CustomEvent<ChatCommand>(EVENT, { detail: command })); return; }
  try { sessionStorage.setItem(PENDING, JSON.stringify(command)); } catch { /* The command is lost; the page still opens. */ }
  navigate("/chat");
}

/**
 * The command another page left for the chat page, read without taking it. The page uses it to know,
 * before it draws anything, that it is being opened to start a new conversation rather than to return
 * to the last one.
 */
export function waitingChatCommand(): ChatCommand | null {
  if (typeof window === "undefined") return null;
  try {
    const pending = sessionStorage.getItem(PENDING);
    return pending ? JSON.parse(pending) as ChatCommand : null;
  } catch { return null; }
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
