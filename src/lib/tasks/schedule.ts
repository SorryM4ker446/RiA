import { t } from "@/lib/locale";

export const TASK_REPEAT_RULES = ["none", "daily", "weekly", "monthly"] as const;
export type TaskRepeatRule = (typeof TASK_REPEAT_RULES)[number];

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value!);
    formatters.set(timeZone, value);
  }
  return value;
}

export function isTaskTimeZone(value: string): boolean {
  // Reject numeric offset zones: recurrence needs calendar rules, including DST.
  if (!value || value.length > 100 || /^[+-]/.test(value)) return false;
  try { formatter(value); return true; } catch { return false; }
}

function wallTime(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date).map(part => [part.type, part.value]));
  return Date.parse(`${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
}

function fromWallTime(wall: number, timeZone: string, allowGap: boolean): Date {
  const offsets = new Set<number>();
  // Sampling both sides of a transition covers DST and full-day calendar shifts.
  for (let hours = -36; hours <= 36; hours += 12) {
    const instant = wall + hours * 3_600_000;
    offsets.add(wallTime(new Date(instant), timeZone) - instant);
  }
  const candidates = [...offsets].map(offset => wall - offset).sort((a, b) => a - b);
  const exact = candidates.find(instant => wallTime(new Date(instant), timeZone) === wall);
  if (exact !== undefined) return new Date(exact); // Earlier occurrence during a clock rollback.
  if (allowGap) {
    const later = candidates.find(instant => wallTime(new Date(instant), timeZone) > wall);
    if (later !== undefined) return new Date(later);
  }
  throw new Error(t("lib.tasks.localTimeMissing"));
}

export function parseTaskDueDate(value: string | null | undefined, timeZone: string): Date | null {
  if (!value?.trim()) return null;
  if (!isTaskTimeZone(timeZone)) throw new Error(t("lib.tasks.invalidTimeZone"));
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value.trim());
  if (!match) throw new Error(t("lib.tasks.dueDateFormat"));
  const local = `${match[1]}T${match[2] ?? "00:00"}:${match[3] ?? "00"}`;
  const wall = Date.parse(`${local}Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 19) !== local || +match[1].slice(0, 4) < 1) {
    throw new Error(t("lib.tasks.invalidDueDate"));
  }
  if (match[5]) {
    const instant = new Date(`${local}${match[4] ?? ""}${match[5]}`);
    if (!Number.isFinite(instant.getTime())) throw new Error(t("lib.tasks.invalidOffset"));
    return instant;
  }
  return new Date(fromWallTime(wall, timeZone, false).getTime() + Number(match[4] ?? 0) * 1000);
}

export function taskLocalInput(value: string, timeZone: string): string {
  return new Date(wallTime(new Date(value), timeZone)).toISOString().slice(0, 16);
}

export function nextTaskDueDate(anchor: Date, current: Date, rule: TaskRepeatRule, timeZone: string, now: Date): Date {
  if (rule === "none") throw new Error("A repeat rule is required");
  const original = new Date(wallTime(anchor, timeZone));
  const after = Math.max(now.getTime(), current.getTime());
  const localAfter = new Date(wallTime(new Date(after), timeZone));
  const dayMs = 86_400_000;
  let interval = rule === "monthly"
    ? (localAfter.getUTCFullYear() - original.getUTCFullYear()) * 12 + localAfter.getUTCMonth() - original.getUTCMonth()
    : Math.floor((localAfter.getTime() - original.getTime()) / (dayMs * (rule === "weekly" ? 7 : 1)));
  interval = Math.max(1, interval);
  for (let attempt = 0; attempt < 4; attempt++, interval++) {
    const candidate = new Date(original);
    if (rule === "monthly") {
      candidate.setUTCDate(1);
      candidate.setUTCMonth(original.getUTCMonth() + interval);
      const lastDay = new Date(candidate);
      lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
      candidate.setUTCDate(Math.min(original.getUTCDate(), lastDay.getUTCDate()));
    } else {
      candidate.setUTCDate(original.getUTCDate() + interval * (rule === "weekly" ? 7 : 1));
    }
    if (!Number.isFinite(candidate.getTime()) || candidate.getUTCFullYear() > 9999) break;
    const next = fromWallTime(candidate.getTime(), timeZone, true);
    if (next.getTime() > after) return next;
  }
  throw new Error(t("lib.tasks.noNextDueDate"));
}
