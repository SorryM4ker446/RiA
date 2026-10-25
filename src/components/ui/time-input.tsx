"use client";

import { useState, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { cn } from "@/lib/utils/cn";
import { isTimeOfDay, parseTimeOfDay } from "@/lib/time-of-day";

/**
 * A time of day, always in 24-hour form. The native time input follows the
 * system's locale and shows AM/PM even in the Chinese interface, so this is a
 * text field that accepts a typed time and tidies it on leaving. Only a
 * complete time is passed on; an unfinished one is kept as typed and, if it
 * still is not a time on leaving, put back to the last good value.
 */
export function TimeInput({ value, onChange, onBlur, className, ...props }: Omit<ComponentProps<typeof Input>, "value" | "onChange" | "type"> & { value: string; onChange: (value: string) => void }) {
  useLocale();
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  if (value !== shown) { setShown(value); setDraft(value); }
  return <Input
    {...props}
    type="text"
    inputMode="numeric"
    autoComplete="off"
    maxLength={5}
    placeholder="09:00"
    pattern="([01]\d|2[0-3]):[0-5]\d"
    title={t("ui.time.format")}
    data-time-input=""
    className={cn("tabular-nums", className)}
    value={draft}
    onChange={event => {
      setDraft(event.target.value);
      if (isTimeOfDay(event.target.value)) onChange(event.target.value);
    }}
    onBlur={event => {
      const time = parseTimeOfDay(draft);
      if (time) { setDraft(time); if (time !== value) onChange(time); }
      else setDraft(value);
      onBlur?.(event);
    }}
  />;
}
