/*
 * When a task runs.
 *
 * A repeating task is a five-field cron expression read in the task's own time
 * zone: minute, hour, day of month, month, day of week. A task that runs once
 * holds an instant instead. Everything here is plain arithmetic on wall-clock
 * time, so the same code describes a schedule in the interface and decides it
 * in the service.
 */

export type CronFields = {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** Whether the day-of-month and day-of-week fields name particular days. */
  restrictsDayOfMonth: boolean;
  restrictsDayOfWeek: boolean;
};

const FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

/** How far ahead an occurrence is looked for. Long enough to reach a 29 February. */
const SEARCH_DAYS = 366 * 8 + 2;

function parseField(source: string, [low, high]: readonly [number, number]): number[] | null {
  const values = new Set<number>();
  for (const part of source.split(",")) {
    const match = /^(\*|\d{1,2})(?:-(\d{1,2}))?(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) return null;
    const step = match[3] === undefined ? 1 : Number(match[3]);
    if (step < 1) return null;
    if (match[1] === "*" && match[2] !== undefined) return null;
    const from = match[1] === "*" ? low : Number(match[1]);
    // "5/15" means from five onwards in steps, as cron reads it.
    const to = match[1] === "*" ? high : match[2] !== undefined ? Number(match[2]) : match[3] !== undefined ? high : from;
    if (from < low || to > high || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values.size ? [...values].sort((a, b) => a - b) : null;
}

/** The parts of a cron expression, or null when it is not one. */
export function parseCron(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = parts.map((part, index) => parseField(part, FIELD_RANGES[index]));
  if (fields.some(field => field === null)) return null;
  const [minutes, hours, daysOfMonth, months, weekdays] = fields as number[][];
  return {
    minutes, hours, daysOfMonth, months,
    // Sunday is both 0 and 7.
    daysOfWeek: [...new Set(weekdays.map(day => day % 7))].sort((a, b) => a - b),
    restrictsDayOfMonth: !parts[2].startsWith("*"),
    restrictsDayOfWeek: !parts[4].startsWith("*"),
  };
}

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

export function isTimeZone(value: string): boolean {
  // Numeric offsets are refused: a schedule needs calendar rules, including daylight saving.
  if (!value || value.length > 100 || /^[+-]/.test(value)) return false;
  try { formatter(value); return true; } catch { return false; }
}

/** The wall-clock reading of an instant in a zone, as if it were UTC. */
function wallTime(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

/**
 * The instant a wall-clock time happens in a zone, or null when it does not.
 *
 * The zone's offset is sampled on both sides of the time rather than assumed,
 * so a time on the day the clocks change resolves to the instant that really
 * reads that way. A time the clocks jump over has no instant; a time they pass
 * twice resolves to the earlier one, so a task set for it runs once.
 */
export function instantOfLocalTime(wall: number, timeZone: string): Date | null {
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 12) {
    const instant = wall + hours * 3_600_000;
    offsets.add(wallTime(instant, timeZone) - instant);
  }
  const exact = [...offsets].map(offset => wall - offset).sort((a, b) => a - b).find(instant => wallTime(instant, timeZone) === wall);
  return exact === undefined ? null : new Date(exact);
}

/**
 * The first time at or after `from` that the expression names, or null when it
 * names none within the search horizon (the 31st of a thirty-day month).
 */
export function nextCronOccurrence(expression: string, timeZone: string, from: Date): Date | null {
  const fields = parseCron(expression);
  if (!fields) return null;
  const start = new Date(wallTime(from.getTime(), timeZone));
  const startOfDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const startMinutes = start.getUTCHours() * 60 + start.getUTCMinutes();
  for (let offset = 0; offset <= SEARCH_DAYS; offset += 1) {
    const day = new Date(startOfDay + offset * 86_400_000);
    if (!fields.months.includes(day.getUTCMonth() + 1)) continue;
    const onDayOfMonth = fields.daysOfMonth.includes(day.getUTCDate());
    const onDayOfWeek = fields.daysOfWeek.includes(day.getUTCDay());
    // Cron's own rule: when both day fields name days, either one is enough.
    const matches = fields.restrictsDayOfMonth && fields.restrictsDayOfWeek ? onDayOfMonth || onDayOfWeek : onDayOfMonth && onDayOfWeek;
    if (!matches) continue;
    for (const hour of fields.hours) for (const minute of fields.minutes) {
      // Times well before `from` on its own day cannot be the answer. The margin
      // covers a clock that was set back, where an earlier reading is a later instant.
      if (offset === 0 && hour * 60 + minute < startMinutes - 180) continue;
      const instant = instantOfLocalTime(day.getTime() + (hour * 60 + minute) * 60_000, timeZone);
      if (instant && instant.getTime() >= from.getTime()) return instant;
    }
  }
  return null;
}

/**
 * A date and time written without an offset, read in the zone; with one, the
 * instant it names. Null when it is not a time that exists.
 */
export function parseRunTime(value: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value.trim());
  if (!match) return null;
  if (match[7]) {
    const instant = new Date(value.trim());
    return Number.isFinite(instant.getTime()) ? instant : null;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(part => Number(part ?? 0));
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const read = new Date(wall);
  // A date that rolled over (the 31st of June) is not the date that was written.
  if (read.getUTCFullYear() !== year || read.getUTCMonth() !== month - 1 || read.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  return instantOfLocalTime(wall, timeZone);
}

/** An instant as the date and time a form shows for it in a zone: `YYYY-MM-DDTHH:mm`. */
export function localInputOf(instant: Date, timeZone: string): string {
  return new Date(wallTime(instant.getTime(), timeZone)).toISOString().slice(0, 16);
}

export type SchedulePreset =
  | { type: "once" }
  | { type: "hourly"; minute: number }
  | { type: "daily"; time: string }
  | { type: "weekdays"; time: string }
  | { type: "weekly"; time: string; dayOfWeek: number }
  | { type: "monthly"; time: string; dayOfMonth: number }
  | { type: "custom"; cron: string };

const pad = (value: number) => String(value).padStart(2, "0");

/** The cron expression a form choice stands for. A task that runs once has none. */
export function cronOfPreset(preset: SchedulePreset): string | null {
  if (preset.type === "once") return null;
  if (preset.type === "custom") return preset.cron.trim();
  if (preset.type === "hourly") return `${preset.minute} * * * *`;
  const [hour, minute] = preset.time.split(":").map(Number);
  if (preset.type === "daily") return `${minute} ${hour} * * *`;
  if (preset.type === "weekdays") return `${minute} ${hour} * * 1-5`;
  if (preset.type === "weekly") return `${minute} ${hour} * * ${preset.dayOfWeek}`;
  return `${minute} ${hour} ${preset.dayOfMonth} * *`;
}

/** The form choice an expression matches, so a saved schedule opens as what it was set to. */
export function presetOfCron(cron: string | null): SchedulePreset {
  if (cron === null) return { type: "once" };
  const parts = cron.trim().split(/\s+/);
  const plain = (value: string | undefined) => value !== undefined && /^\d{1,2}$/.test(value);
  if (parts.length === 5 && plain(parts[0]) && parts[3] === "*") {
    const [minute, hour, dayOfMonth, , dayOfWeek] = parts;
    if (hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") return { type: "hourly", minute: Number(minute) };
    if (plain(hour)) {
      const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
      if (dayOfMonth === "*" && dayOfWeek === "*") return { type: "daily", time };
      if (dayOfMonth === "*" && dayOfWeek === "1-5") return { type: "weekdays", time };
      if (dayOfMonth === "*" && plain(dayOfWeek)) return { type: "weekly", time, dayOfWeek: Number(dayOfWeek) % 7 };
      if (plain(dayOfMonth) && dayOfWeek === "*") return { type: "monthly", time, dayOfMonth: Number(dayOfMonth) };
    }
  }
  return { type: "custom", cron: cron.trim() };
}
