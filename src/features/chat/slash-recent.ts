const STORAGE_KEY = "chat:slash-recent";
const KEEP = 8;

/** What was chosen last, newest first. A convenience for this viewer; losing it changes nothing but the order. */
export function recentSlashItems(): string[] {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [];
  } catch { return []; }
}

export function rememberSlashItem(key: string) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify([key, ...recentSlashItems().filter(item => item !== key)].slice(0, KEEP))); }
  catch { /* Only an ordering hint. */ }
}
