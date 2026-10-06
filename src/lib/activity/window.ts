import { isTaskTimeZone } from "@/lib/tasks/schedule";
type Day = { year: number; month: number; day: number };
const ordinal = (day: Day) => Date.UTC(day.year, day.month - 1, day.day);
function shift(day: Day, days: number): Day {
  const next = new Date(ordinal(day) + days * 86_400_000);
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}
function parts(formatter: Intl.DateTimeFormat, time: number): Day {
  const entries = formatter.formatToParts(time);
  const read = (type: string) => Number(entries.find(entry => entry.type === type)!.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}
// Find the earliest instant reaching this calendar date. A bounded minute sweep
// also handles skipped midnight and repeated hours without assuming a 24h day.
function boundary(day: Day, formatter: Intl.DateTimeFormat): Date {
  const target = ordinal(day);
  const lower = target - 36 * 3_600_000, upper = target + 36 * 3_600_000;
  for (let candidate = lower; candidate <= upper; candidate += 60_000) {
    if (ordinal(parts(formatter, candidate)) >= target) return new Date(candidate);
  }
  throw new Error("Cannot resolve local date boundary");
}
export function reviewWindow(period: "daily" | "weekly", timeZone: string, now = new Date()) {
  if (!isTaskTimeZone(timeZone) || !Number.isFinite(now.getTime())) throw new Error("Invalid review period");
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = parts(formatter, now.getTime());
  const endDay = period === "daily" ? today : shift(today, -((new Date(ordinal(today)).getUTCDay() + 6) % 7));
  const startDay = shift(endDay, period === "daily" ? -1 : -7);
  return { period, timeZone: formatter.resolvedOptions().timeZone,
    startAt: boundary(startDay, formatter), endAt: boundary(endDay, formatter),
    startDate: new Date(ordinal(startDay)).toISOString().slice(0, 10), endDate: new Date(ordinal(endDay)).toISOString().slice(0, 10),
  };
}
