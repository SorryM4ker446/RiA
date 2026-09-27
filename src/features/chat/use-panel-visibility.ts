"use client";
import { useCallback, useSyncExternalStore } from "react";
import { readPanelVisibility, writePanelVisibility, type PanelVisibility } from "./preferences";

/**
 * localStorage is external mutable state, so it is read through
 * `useSyncExternalStore` rather than mirrored into `useState` from an effect:
 * the snapshot stays referentially stable until something actually writes, and
 * the server can render both rails open without a hydration mismatch.
 */
const SERVER_SNAPSHOT: PanelVisibility = { conversations: true, tasks: true };

let cache: PanelVisibility | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): PanelVisibility {
  cache ??= readPanelVisibility();
  return cache;
}

function getServerSnapshot(): PanelVisibility {
  return SERVER_SNAPSHOT;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Another tab may have toggled a rail; drop the cache so this one re-reads.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.endsWith("panel-visibility")) {
      cache = null;
      onChange();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function emit(value: PanelVisibility): void {
  cache = value;
  writePanelVisibility(value);
  for (const listener of listeners) listener();
}

/** Collapse state for the two side rails, shared across the chat workspace. */
export function usePanelVisibility() {
  const visibility = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = useCallback((panel: keyof PanelVisibility) => {
    const current = getSnapshot();
    emit({ ...current, [panel]: !current[panel] });
  }, []);

  return { visibility, toggle };
}
