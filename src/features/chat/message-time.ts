import { useEffect, useState } from "react";
import { formatDateTime, t } from "@/lib/locale";

/** When a message was saved, as its metadata carries it; null when it has none yet. */
export function readMessageTime(metadata: unknown): Date | null {
  const value = (metadata as { createdAt?: unknown } | null | undefined)?.createdAt;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * As short as still says when: the time today, "yesterday" and the time, then the
 * date and time, with the year only once it is not this year. Always an exact time
 * rather than "5 minutes ago", so a hovered message never needs working out and
 * two messages can be compared.
 */
export function formatMessageTime(at: Date, now = new Date()): string {
  const clock: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  // Rounded because a day with a clock change is not 24 hours long.
  const daysAgo = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (daysAgo === 0) return formatDateTime(at, clock);
  if (daysAgo === 1) return `${t("chat.conversations.yesterday")} ${formatDateTime(at, clock)}`;
  return formatDateTime(at, { ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }), month: "short", day: "numeric", ...clock });
}

/** The full date and the time to the minute, for the tooltip. */
export const fullMessageTime = (at: Date) => formatDateTime(at, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Renders again at midnight, so a window left open does not keep calling yesterday today.
 * Returns a count that changes at each midnight, for content that renders only when its props change.
 */
export function useDayRollover() {
  const [day, setDay] = useState(0);
  useEffect(() => {
    const midnight = new Date();
    midnight.setHours(24, 0, 1, 0);
    const timer = setTimeout(() => setDay(current => current + 1), midnight.getTime() - Date.now());
    return () => clearTimeout(timer);
  }, [day]);
  return day;
}
