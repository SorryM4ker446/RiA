"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { applyLocale, DEFAULT_LOCALE, getLocale, LOCALE_STORAGE_KEY, normalizeLocale, subscribeLocale, type Locale } from "./index";

/** Subscribe wherever interface copy is rendered; switching preserves component state. */
export function useLocale() {
  return useSyncExternalStore<Locale>(subscribeLocale, getLocale, () => DEFAULT_LOCALE);
}

export async function saveLocale(locale: Locale): Promise<void> {
  const bridge = window.privateAiDesktop;
  if (bridge) {
    // Desktop origins use a new port on each launch. Its settings file owns
    // persistence; origin-scoped browser storage cannot survive that lifecycle.
    const result = await bridge.saveSettings({ locale });
    applyLocale(normalizeLocale(result.settings.locale));
  } else {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    applyLocale(locale);
  }
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    let current = true;
    const initialLocale = getLocale();
    const bridge = window.privateAiDesktop;
    if (bridge) {
      void bridge.getSettings().then(settings => {
        if (current && getLocale() === initialLocale) applyLocale(normalizeLocale(settings.locale));
      }).catch(() => { /* Settings reports read failures; Chinese remains usable. */ });
    } else {
      try { applyLocale(normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY))); } catch { /* Storage may be unavailable. */ }
    }
    const onStorage = (event: StorageEvent) => {
      if (!bridge && (event.key === LOCALE_STORAGE_KEY || event.key === null)) {
        applyLocale(normalizeLocale(event.newValue));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => { current = false; window.removeEventListener("storage", onStorage); };
  }, []);
  return children;
}
