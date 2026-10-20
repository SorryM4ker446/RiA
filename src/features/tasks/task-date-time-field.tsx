"use client";

import { useId, useState } from "react";
import { CalendarDays } from "lucide-react";
import { enUS, zhCN } from "react-day-picker/locale";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { t } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";

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
  const date = datePart ? new Date(`${datePart}T12:00:00`) : undefined;
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
                if (selected) {
                  const day = `${selected.getFullYear()}-${String(selected.getMonth() + 1).padStart(2, "0")}-${String(selected.getDate()).padStart(2, "0")}`;
                  onChange(`${day}T${timePart || "09:00"}`);
                } else onChange("");
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
        <Input
          id={`${id}-time`}
          type="time"
          value={timePart}
          disabled={disabled || !datePart}
          required={!!datePart}
          onChange={(event) => onChange(`${datePart}T${event.target.value}`)}
        />
      </Field>
      {name && <input type="hidden" name={name} value={value} />}
    </FieldGroup>
  );
}
