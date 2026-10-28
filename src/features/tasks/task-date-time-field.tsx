"use client";

import { useId, useState } from "react";
import { CalendarDays } from "lucide-react";
import { enUS, zhCN } from "react-day-picker/locale";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { TimeInput } from "@/components/ui/time-input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { t } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { cn } from "@/lib/utils/cn";

const dayString = (day: Date) => `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
const parseDay = (datePart: string) => datePart ? new Date(`${datePart}T12:00:00`) : undefined;

/** Keep wall-clock fields separate from instants; the task's time zone is applied on save. */
export function TaskDateTimeField({
  value,
  onChange,
  label,
  disabled,
  name,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  name?: string;
}) {
  const locale = useLocale();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [datePart = "", timePart = ""] = value.split("T");
  const date = parseDay(datePart);
  return (
    <FieldGroup className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
      <Field className="min-w-0 gap-2" data-disabled={disabled}>
        <FieldLabel htmlFor={`${id}-date`}>{label}</FieldLabel>
        <Popover open={open && !disabled} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              id={`${id}-date`}
              variant="outline"
              className="w-full justify-start"
              disabled={disabled}
            >
              <CalendarDays data-icon="inline-start" aria-hidden="true" />
              <span className="truncate">
                {date
                  ? date.toLocaleDateString(locale, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })
                  : t("tasks.datePlaceholder")}
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-auto max-w-[calc(100vw-2rem)] p-0"
            aria-label={label}
          >
            <Calendar
              mode="single"
              selected={date}
              defaultMonth={date}
              locale={locale === "zh-CN" ? zhCN : enUS}
              autoFocus
              onSelect={(selected) => {
                if (selected) onChange(`${dayString(selected)}T${timePart || "09:00"}`);
                else onChange("");
                setOpen(false);
              }}
            />
            <div className="flex justify-end border-t p-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={!datePart}
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                {t("tasks.clearDate")}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </Field>
      <Field className="min-w-0 gap-2" data-disabled={disabled || !datePart}>
        <FieldLabel htmlFor={`${id}-time`}>{t("tasks.time")}</FieldLabel>
        <TimeInput
          id={`${id}-time`}
          value={timePart}
          disabled={disabled || !datePart}
          required={!!datePart}
          onChange={(time) => onChange(`${datePart}T${time}`)}
        />
      </Field>
      {name && <input type="hidden" name={name} value={value} />}
    </FieldGroup>
  );
}

/**
 * The same date and time as one compact button, for a row of other controls
 * such as the composer's task fields. The day and the time are chosen in one
 * popover, so the button never stands apart from a second time field.
 */
export function TaskDateTimeButton({
  value,
  onChange,
  label,
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const locale = useLocale();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [datePart = "", timePart = ""] = value.split("T");
  const date = parseDay(datePart);
  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={date ? `${label} ${datePart} ${timePart}` : label}
          className={cn("justify-start tabular-nums", !date && "text-muted-foreground", className)}
          disabled={disabled}
        >
          <CalendarDays data-icon="inline-start" aria-hidden="true" />
          <span className="truncate">
            {date
              ? `${date.toLocaleDateString(locale, { month: "short", day: "numeric" })} ${timePart}`
              : label}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        // Kept over the row it belongs to, not out over the page beside it.
        align="end"
        className="w-auto max-w-[calc(100vw-2rem)] p-0"
        aria-label={label}
      >
        <Calendar
          mode="single"
          selected={date}
          defaultMonth={date}
          locale={locale === "zh-CN" ? zhCN : enUS}
          autoFocus
          onSelect={(selected) => onChange(selected ? `${dayString(selected)}T${timePart || "09:00"}` : "")}
        />
        <div className="flex items-center gap-2 border-t p-2">
          <label className="sr-only" htmlFor={`${id}-time`}>{t("tasks.time")}</label>
          <TimeInput
            id={`${id}-time`}
            className="h-8 w-20"
            value={timePart}
            disabled={!datePart}
            onChange={(time) => onChange(`${datePart}T${time}`)}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={!datePart}
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
          >
            {t("tasks.clearDate")}
          </Button>
          <Button type="button" size="sm" onClick={() => setOpen(false)}>
            {t("tasks.dateDone")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
