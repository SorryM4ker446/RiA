"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { applyLocale, DEFAULT_LOCALE, getLocale, LOCALE_STORAGE_KEY, normalizeLocale, subscribeLocale, systemLocale, type Locale } from "./index";

/** Subscribe wherever interface copy is rendered; switching preserves component state. */
export function useLocale() {
  return useSyncExternalStore<Locale>(subscribeLocale, getLocale, () => DEFAULT_LOCALE);
}

/**
 * Tells the service the language the user chose, so work that runs with nobody
 * looking, such as a task made from a template, is worded in it. A failure is
 * harmless: the interface itself has already switched.
 */
function saveServiceLocale(locale: Locale) {
  void fetch("/api/interface-locale", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale }) }).catch(() => undefined);
}

export async function saveLocale(locale: Locale): Promise<void> {
  const bridge = window.riaDesktop;
  if (bridge) {
    // Desktop origins use a new port on each launch. Its settings file owns
    // persistence; origin-scoped browser storage cannot survive that lifecycle.
    const result = await bridge.saveSettings({ locale });
    applyLocale(normalizeLocale(result.settings.locale));
  } else {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    applyLocale(locale);
  }
  saveServiceLocale(getLocale());
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    let current = true;
    const settle = (locale: Locale) => applyLocale(locale);
    const initialLocale = getLocale();
    const bridge = window.riaDesktop;
    const fallback = systemLocale(navigator.languages.length ? navigator.languages : [navigator.language]);
    if (bridge) {
      void bridge.getSettings().then(settings => {
        if (current && getLocale() === initialLocale) settle(normalizeLocale(settings.locale, fallback));
      }).catch(() => { if (current && getLocale() === initialLocale) settle(fallback); });
    } else {
      let preference: string | null = null;
      try { preference = localStorage.getItem(LOCALE_STORAGE_KEY); } catch { /* Use the system language when storage is unavailable. */ }
      settle(normalizeLocale(preference, fallback));
    }
    const onStorage = (event: StorageEvent) => {
      if (!bridge && (event.key === LOCALE_STORAGE_KEY || event.key === null)) {
        applyLocale(normalizeLocale(event.newValue, fallback));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => { current = false; window.removeEventListener("storage", onStorage); };
  }, []);
  return children;
}
