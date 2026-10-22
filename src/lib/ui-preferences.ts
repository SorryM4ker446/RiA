export const THEME_STORAGE_KEY = "ui:theme";
export const DEFAULT_THEME = "dark";
export const PANEL_VISIBILITY_STORAGE_KEY = "ria.chat.panel-visibility";
/** The panel preference's name before the product was renamed RiA. */
export const LEGACY_PANEL_VISIBILITY_STORAGE_KEY = "private-ai.chat.panel-visibility";

/**
 * Read a browser-stored value, moving one saved under its pre-rename key to
 * the current key the first time it is read. A value already stored under the
 * current key wins, and the stale legacy copy is discarded. If the move cannot
 * be written, the legacy value is still returned and the move is retried on
 * the next read.
 */
export function readRenamedStorageItem(storage: Storage, key: string, legacyKey: string): string | null {
  const current = storage.getItem(key);
  const legacy = storage.getItem(legacyKey);
  if (legacy === null) return current;
  if (current !== null) { storage.removeItem(legacyKey); return current; }
  try { storage.setItem(key, legacy); storage.removeItem(legacyKey); } catch { /* retried on the next read */ }
  return legacy;
}
