"use client";

import { createContext, useContext } from "react";

/**
 * The place in the window's top row that a page may fill with its own heading: the chat page
 * puts the conversation's title and menu there. Null on pages that keep the section name.
 */
export const TopbarSlotContext = createContext<HTMLElement | null>(null);

export function useTopbarSlot() {
  return useContext(TopbarSlotContext);
}
