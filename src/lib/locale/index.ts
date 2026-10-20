import { zhCN, type MessageKey } from "./zh-CN";
import { enUS } from "./en-US";

export const DEFAULT_LOCALE = "zh-CN";
export const LOCALE_STORAGE_KEY = "ui:locale";
export type Locale = "zh-CN" | "en-US";

export function normalizeLocale(value: unknown, fallback: Locale = DEFAULT_LOCALE): Locale {
  return value === "en-US" || value === "zh-CN" ? value : fallback;
}

export function systemLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return "zh-CN";
    if (/^en(?:-|$)/i.test(language)) return "en-US";
  }
  return "en-US";
}

// Server copy and model prompts never inherit a browser's preference.
let rendererLocale: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();
export function getLocale(): Locale {
  return typeof window === "undefined" ? DEFAULT_LOCALE : rendererLocale;
}
export function subscribeLocale(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function applyLocale(locale: Locale) {
  if (typeof window === "undefined") return;
  document.documentElement.lang = locale;
  if (rendererLocale === locale) return;
  rendererLocale = locale;
  listeners.forEach(listener => listener());
}

export function t(key: MessageKey, locale: Locale = getLocale()): string {
  return (locale === "en-US" ? enUS : zhCN)[key];
}
export function tf(key: MessageKey, vars: Record<string, string | number>, locale: Locale = getLocale()): string {
  return t(key, locale).replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  );
}
export function formatDateTime(value: string | number | Date, options: Intl.DateTimeFormatOptions = {}, locale: Locale = getLocale()): string {
  return new Date(value).toLocaleString(locale, options);
}
export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return value.toLocaleString(getLocale(), options);
}

const messageKeys = Object.keys(zhCN) as MessageKey[];
const knownMessages = new Map<string, MessageKey>();
for (const key of messageKeys) {
  if (!knownMessages.has(zhCN[key])) knownMessages.set(zhCN[key], key);
  if (!knownMessages.has(enUS[key])) knownMessages.set(enUS[key], key);
}

/** Localize known application metadata/errors at the display boundary only.
 * Never apply this to user documents, conversation text, or model output. */
export function localizeMessage(value: string): string {
  const key = knownMessages.get(value);
  return key ? t(key) : value;
}

export type { MessageKey };
