"use client";

import { useSyncExternalStore } from "react";
import { RAIL_BOUNDS, RAIL_NARROW_QUERY, RAIL_STORAGE_KEY } from "@/lib/ui-preferences";

/**
 * The sidebar's width and whether it is folded away.
 *
 * The root element holds the whole state, and the stylesheet reads it:
 * `--rail-width`; `data-rail-collapsed`, the choice for wide windows, saved
 * and set by the head script before the first paint; and `data-rail-pinned`,
 * a narrow window's choice for now. Which of the two applies is decided by a
 * media query, so a window crossing the boundary is laid out correctly in the
 * same frame. A narrow window starts folded again each time it narrows.
 */
export type RailState = { width: number; folded: boolean };

const SERVER_STATE: RailState = { width: RAIL_BOUNDS.default, folded: false };
const listeners = new Set<() => void>();
let snapshot: RailState | null = null;
let watching = false;
let settling = 0;
/** One shared duration, plus a frame of slack, for every part that moves with a change the person made. */
const ANIMATION_MS = 280;

export const clampRailWidth = (width: number) => Math.round(Math.min(RAIL_BOUNDS.max, Math.max(RAIL_BOUNDS.min, width)));
const isNarrow = () => window.matchMedia(RAIL_NARROW_QUERY).matches;

export function readRail(): RailState {
  if (snapshot) return snapshot;
  const root = document.documentElement;
  const width = Number.parseFloat(root.style.getPropertyValue("--rail-width"));
  const folded = isNarrow() ? root.dataset.railPinned !== "true" : root.dataset.railCollapsed === "true";
  snapshot = { width: Number.isFinite(width) ? clampRailWidth(width) : RAIL_BOUNDS.default, folded };
  return snapshot;
}

function publish() {
  snapshot = null;
  for (const listener of listeners) listener();
}

/** Lets the next change of width or fold ease; see the stylesheet's sidebar section. */
function animate() {
  const root = document.documentElement;
  root.dataset.railAnimating = "";
  window.clearTimeout(settling);
  settling = window.setTimeout(() => { delete root.dataset.railAnimating; }, ANIMATION_MS);
}

/** Shows a fold for the current window without saving it, for a drag still in progress. */
export function showFolded(folded: boolean) {
  const root = document.documentElement;
  animate();
  if (!isNarrow()) root.dataset.railCollapsed = String(folded);
  else if (folded) delete root.dataset.railPinned;
  else root.dataset.railPinned = "true";
}

/** Applies a layout to the page and remembers it. */
export function setRail(next: RailState) {
  const width = clampRailWidth(next.width);
  const root = document.documentElement;
  root.style.setProperty("--rail-width", `${width}px`);
  showFolded(next.folded);
  try { localStorage.setItem(RAIL_STORAGE_KEY, JSON.stringify({ width, collapsed: root.dataset.railCollapsed === "true" })); } catch { /* a convenience; the page still follows it */ }
  publish();
}

function watchWindow() {
  if (watching) return;
  watching = true;
  // The stylesheet already lays the window out for its new width; a pin made
  // while narrow lasts only until the window crosses back.
  window.matchMedia(RAIL_NARROW_QUERY).addEventListener("change", () => {
    delete document.documentElement.dataset.railPinned;
    publish();
  });
}

function subscribe(listener: () => void) {
  watchWindow();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useRailLayout(): RailState {
  return useSyncExternalStore(subscribe, readRail, () => SERVER_STATE);
}
