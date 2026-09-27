import { zhCN, type MessageKey } from "./zh-CN";

/**
 * Active locale.
 *
 * The interface is Chinese, so this resolves to `zh-CN` unconditionally. When
 * English lands, add `en-US.ts` with the same `MessageKey` set and switch the
 * selection here — every user-facing string already comes from this module, so
 * no component has to change.
 */
const active = zhCN;

/**
 * BCP 47 tag for the active locale.
 *
 * Date and number formatting has to follow the interface language too: a
 * Chinese interface showing `Jan 31, 2026` (or worse, an English interface
 * showing `01月31日`) reads as a bug. Components format through this instead of
 * hard-coding a tag, so switching `active` above switches dates with it.
 */
const activeTag = "zh-CN";

/** Format a timestamp the way the active interface language writes it. */
export function formatDateTime(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = {},
): string {
  return new Date(value).toLocaleString(activeTag, options);
}

/** Look up interface copy. Keys are type-checked, so a typo fails the build. */
export function t(key: MessageKey): string {
  return active[key];
}

/**
 * Look up a message that embeds runtime values, e.g.
 * `tf("tools.createTask.created", { title, due, reminder, repeat, status })`.
 *
 * Placeholders stay inside the message so a translator can move a value
 * anywhere in the sentence. Concatenating fragments around the values instead
 * would freeze the word order of whichever language wrote the code.
 *
 * An unmatched placeholder is left in place rather than blanked, so a missing
 * variable shows up during review instead of silently producing a hole.
 */
export function tf(key: MessageKey, vars: Record<string, string | number>): string {
  return active[key].replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export type { MessageKey };
