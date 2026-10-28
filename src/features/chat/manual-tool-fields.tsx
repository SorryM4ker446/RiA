"use client";

import type { Dispatch, SetStateAction } from "react";
import { localizeMessage } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TaskDateTimeButton } from "@/features/tasks/task-date-time-field";
import { getManualToolFieldError } from "@/features/chat/tool-input";
import type { ManualToolFieldMeta } from "@/features/chat/types";
import { cn } from "@/lib/utils/cn";

type Values = Record<string, string>;

/**
 * A tool's extra inputs as one row of small controls inside the composer,
 * under the line the tool's main input is typed on. The composer keeps its
 * height (the text area gives up the row's room), so choosing a tool no longer
 * moves the composer or what sits above it.
 */
export function ManualToolFields({ fields, values, setValues, errors, setErrors, disabled, className }: {
  fields: readonly ManualToolFieldMeta[];
  values: Values;
  setValues: Dispatch<SetStateAction<Values>>;
  errors: Values;
  setErrors: Dispatch<SetStateAction<Values>>;
  disabled?: boolean;
  className?: string;
}) {
  useLocale();
  const set = (key: string, value: string) => setValues(previous => ({ ...previous, [key]: value }));
  return <div className={cn("flex min-w-0 shrink-0 items-center gap-1 px-2 pb-1.5", className)} role="group">
    {fields.map(field => {
      const label = localizeMessage(field.label);
      const value = values[field.key] ?? "";
      if (field.type === "select") return <Select key={field.key} disabled={disabled} value={value || field.defaultValue || ""} onValueChange={next => set(field.key, next)}>
        <SelectTrigger aria-label={label} variant="ghost" size="sm" className="w-auto shrink-0">
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-muted-foreground">{label}</span>
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectContent>
          {(field.options ?? []).map(option => <SelectItem key={option.value} value={option.value}>{localizeMessage(option.label)}</SelectItem>)}
        </SelectContent>
      </Select>;
      if (field.type === "datetime-local") return <TaskDateTimeButton key={field.key} label={label} disabled={disabled} className="shrink-0" value={value} onChange={next => set(field.key, next)} />;
      const error = errors[field.key];
      const errorId = `manual-tool-${field.key}-error`;
      return <div key={field.key} className="flex min-w-0 flex-1 items-center gap-2">
        <Input
          id={`manual-tool-${field.key}`}
          aria-label={label}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          disabled={disabled}
          className={cn("h-8 min-w-0 flex-1 border-transparent bg-muted/50 shadow-none hover:bg-muted focus-visible:bg-background", error && "border-destructive/60")}
          inputMode={field.type === "number" ? "decimal" : undefined}
          placeholder={localizeMessage(field.placeholder ?? field.label)}
          type="text"
          value={value}
          onChange={event => {
            const next = event.target.value;
            set(field.key, next);
            setErrors(previous => {
              const nextError = getManualToolFieldError(field, next);
              if (nextError) return { ...previous, [field.key]: nextError };
              const rest = { ...previous };
              delete rest[field.key];
              return rest;
            });
          }}
        />
        {error ? <p className="shrink-0 truncate text-[11px] text-destructive/90" id={errorId} role="alert">{localizeMessage(error)}</p> : null}
      </div>;
    })}
  </div>;
}
