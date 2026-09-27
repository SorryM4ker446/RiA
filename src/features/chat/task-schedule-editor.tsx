import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/lib/locale";
import { isTaskTimeZone, parseTaskDueDate, taskLocalInput } from "@/lib/tasks/schedule";
import type { TaskItem, TaskScheduleInput } from "./types";

export const repeatLabels = {
  none: t("chat.schedule.repeatNone"),
  daily: t("chat.schedule.repeatDaily"),
  weekly: t("chat.schedule.repeatWeekly"),
  monthly: t("chat.schedule.repeatMonthly"),
};

export function TaskScheduleEditor({ task, onSave, disabled }: {
  task: TaskItem;
  onSave: (id: string, input: TaskScheduleInput) => Promise<boolean>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <div className="mt-2">
    <Button className="h-7 text-xs font-normal" variant="ghost" disabled={disabled} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {t("chat.schedule.openEditor")}
    </Button>
    {open ? <ScheduleForm key={task.updatedAt} task={task} disabled={disabled} onSave={async input => {
      if (await onSave(task.id, input)) setOpen(false);
    }} onCancel={() => setOpen(false)} /> : null}
  </div>;
}

function ScheduleForm({ task, onSave, onCancel, disabled }: {
  task: TaskItem; disabled: boolean; onSave: (input: TaskScheduleInput) => Promise<void>; onCancel: () => void;
}) {
  const initialZone = task.dueDate ? task.timeZone ?? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [timeZone, setTimeZone] = useState(initialZone);
  const [dueDate, setDueDate] = useState(task.dueDate ? taskLocalInput(task.dueDate, initialZone) : "");
  const [reminderEnabled, setReminderEnabled] = useState(task.reminderEnabled ?? false);
  const [repeatRule, setRepeatRule] = useState<TaskScheduleInput["repeatRule"]>(task.repeatRule ?? "none");
  const [error, setError] = useState<string | null>(null);
  return <form className="mt-2 space-y-2 border-t pt-3 text-xs" onSubmit={async event => {
    event.preventDefault();
    setError(null);
    try {
      if (!isTaskTimeZone(timeZone)) throw new Error(t("chat.schedule.errorInvalidTimeZone"));
      // Keep the stored instant when only changing reminder options, including a later DST fold or sub-minute precision.
      const unchangedTime = task.dueDate && timeZone === initialZone && dueDate === taskLocalInput(task.dueDate, initialZone);
      const instant = unchangedTime ? new Date(task.dueDate!) : parseTaskDueDate(dueDate, timeZone);
      if (!instant && (reminderEnabled || repeatRule !== "none")) throw new Error(t("chat.schedule.errorDueDateRequired"));
      await onSave({ dueDate: instant?.toISOString() ?? null, timeZone, reminderEnabled, repeatRule });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("chat.schedule.errorInvalidTime")); }
  }}>
    <fieldset disabled={disabled} className="space-y-2">
      <label className="block space-y-1"><span>{t("chat.schedule.dueDateLabel")}</span><Input type="datetime-local" value={dueDate} onChange={event => setDueDate(event.target.value)} /></label>
      <label className="block space-y-1"><span>{t("chat.schedule.timeZoneLabel")}</span><Input value={timeZone} onChange={event => setTimeZone(event.target.value.trim())} placeholder="Asia/Shanghai" /></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={reminderEnabled} onChange={event => setReminderEnabled(event.target.checked)} />{t("chat.schedule.desktopNotification")}</label>
      <label className="block space-y-1"><span>{t("chat.schedule.repeatLabel")}</span>
        <Select onValueChange={value => setRepeatRule(value as TaskScheduleInput["repeatRule"])} value={repeatRule}>
          <SelectTrigger aria-label={t("chat.schedule.repeatLabel")} className="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(repeatLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
      </label>
      <p className="text-muted-foreground">{t("chat.schedule.repeatHint")}</p>
      {task.repeatGenerated ? <p className="text-muted-foreground">{t("chat.schedule.repeatGeneratedNotice")}</p> : null}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      <div className="flex gap-2"><Button size="sm" type="submit">{disabled ? t("chat.schedule.saving") : t("chat.schedule.save")}</Button><Button size="sm" type="button" variant="ghost" onClick={onCancel}>{t("chat.common.cancel")}</Button></div>
    </fieldset>
  </form>;
}
