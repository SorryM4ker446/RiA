"use client";
import { useLocale } from "@/lib/locale/client";
import { useId, useState } from "react";
import { CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { TaskDateTimeField } from "@/features/tasks/task-date-time-field";
import { t, localizeMessage } from "@/lib/locale";
import {
  isTaskTimeZone,
  parseTaskDueDate,
  taskLocalInput,
} from "@/lib/tasks/schedule";
import type { TaskItem, TaskScheduleInput } from "./types";

export const repeatLabels = () => ({
  none: t("chat.schedule.repeatNone"),
  daily: t("chat.schedule.repeatDaily"),
  weekly: t("chat.schedule.repeatWeekly"),
  monthly: t("chat.schedule.repeatMonthly"),
});

export function TaskScheduleEditor({
  task,
  onSave,
  disabled,
}: {
  task: TaskItem;
  onSave: (id: string, input: TaskScheduleInput) => Promise<boolean>;
  disabled: boolean;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  return (
    <div className="contents">
      <Button
        size="icon-sm"
        className="justify-self-end text-muted-foreground"
        variant="ghost"
        disabled={disabled}
        aria-expanded={open}
        aria-label={t("chat.schedule.openEditor")}
        title={t("chat.schedule.openEditor")}
        onClick={() => setOpen((value) => !value)}
      >
        <CalendarClock aria-hidden="true" />
      </Button>
      {open ? (
        <ScheduleForm
          key={task.updatedAt}
          task={task}
          disabled={disabled}
          onSave={async (input) => {
            if (await onSave(task.id, input)) setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ScheduleForm({
  task,
  onSave,
  onCancel,
  disabled,
}: {
  task: TaskItem;
  disabled: boolean;
  onSave: (input: TaskScheduleInput) => Promise<void>;
  onCancel: () => void;
}) {
  useLocale();
  const id = useId();
  const initialZone = task.dueDate
    ? (task.timeZone ?? "UTC")
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [timeZone, setTimeZone] = useState(initialZone);
  const [dueDate, setDueDate] = useState(
    task.dueDate ? taskLocalInput(task.dueDate, initialZone) : "",
  );
  const [reminderEnabled, setReminderEnabled] = useState(
    task.reminderEnabled ?? false,
  );
  const [repeatRule, setRepeatRule] = useState<TaskScheduleInput["repeatRule"]>(
    task.repeatRule ?? "none",
  );
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="surface-enter col-span-full mt-1 min-w-0 basis-full border-t border-border/55 pt-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          if (!isTaskTimeZone(timeZone))
            throw new Error(t("chat.schedule.errorInvalidTimeZone"));
          // Keep the stored instant when only changing reminder options, including a later DST fold or sub-minute precision.
          const unchangedTime =
            task.dueDate &&
            timeZone === initialZone &&
            dueDate === taskLocalInput(task.dueDate, initialZone);
          const instant = unchangedTime
            ? new Date(task.dueDate!)
            : parseTaskDueDate(dueDate, timeZone);
          if (!instant && (reminderEnabled || repeatRule !== "none"))
            throw new Error(t("chat.schedule.errorDueDateRequired"));
          await onSave({
            dueDate: instant?.toISOString() ?? null,
            timeZone,
            reminderEnabled,
            repeatRule,
          });
        } catch (cause) {
          setError(
            cause instanceof Error
              ? cause.message
              : t("chat.schedule.errorInvalidTime"),
          );
        }
      }}
    >
      <FieldSet disabled={disabled}>
        <FieldGroup className="gap-4">
          <TaskDateTimeField
            label={t("chat.schedule.dueDateLabel")}
            value={dueDate}
            onChange={setDueDate}
            disabled={disabled}
          />
          <Field className="gap-2" data-disabled={disabled}>
            <FieldLabel htmlFor={`${id}-zone`}>
              {t("chat.schedule.timeZoneLabel")}
            </FieldLabel>
            <Input
              id={`${id}-zone`}
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value.trim())}
              placeholder="Asia/Shanghai"
            />
          </Field>
          <Field orientation="horizontal" data-disabled={disabled}>
            <Checkbox
              id={`${id}-reminder`}
              checked={reminderEnabled}
              onCheckedChange={(value) => setReminderEnabled(value === true)}
              disabled={disabled}
            />
            <FieldLabel htmlFor={`${id}-reminder`}>
              {t("chat.schedule.desktopNotification")}
            </FieldLabel>
          </Field>
          <Field className="gap-2" data-disabled={disabled}>
            <FieldLabel htmlFor={`${id}-repeat`}>
              {t("chat.schedule.repeatLabel")}
            </FieldLabel>
            <SelectField
              id={`${id}-repeat`}
              disabled={disabled}
              className="w-full"
              onValueChange={(value) =>
                setRepeatRule(value as TaskScheduleInput["repeatRule"])
              }
              value={repeatRule}
            >
              {Object.entries(repeatLabels()).map(([value, label]) => (
                <SelectOption key={value} value={value}>
                  {label}
                </SelectOption>
              ))}
            </SelectField>
            <FieldDescription>{t("chat.schedule.repeatHint")}</FieldDescription>
          </Field>
          {task.repeatGenerated ? (
            <FieldDescription>
              {t("chat.schedule.repeatGeneratedNotice")}
            </FieldDescription>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{localizeMessage(error)}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" type="submit">
              {disabled ? t("chat.schedule.saving") : t("chat.schedule.save")}
            </Button>
            <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
              {t("chat.common.cancel")}
            </Button>
          </div>
        </FieldGroup>
      </FieldSet>
    </form>
  );
}
