const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A complete 24-hour "HH:mm". */
export function isTimeOfDay(text: string): boolean {
  return TIME.test(text);
}

/** Reads what was typed as a 24-hour time: "9", "930", "9:5" and "21:30" all work. */
export function parseTimeOfDay(text: string): string | null {
  const trimmed = text.trim();
  const match = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(trimmed.includes(":") || trimmed.length <= 2 ? trimmed : `${trimmed.slice(0, -2)}:${trimmed.slice(-2)}`);
  if (!match) return null;
  const hour = Number(match[1]), minute = Number(match[2] ?? 0);
  return hour < 24 && minute < 60 ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : null;
}
