import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isTaskTimeZone, parseTaskDueDate, taskLocalInput } from "@/lib/tasks/schedule";
import type { TaskItem, TaskScheduleInput } from "./types";

export const repeatLabels = { none: "不重复", daily: "每天", weekly: "每周", monthly: "每月" } as const;

export function TaskScheduleEditor({ task, onSave, disabled }: {
  task: TaskItem;
  onSave: (id: string, input: TaskScheduleInput) => Promise<boolean>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <div className="mt-2">
    <Button className="h-7 text-xs" variant="ghost" disabled={disabled} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      设置时间与提醒
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
      if (!isTaskTimeZone(timeZone)) throw new Error("请输入有效的 IANA 时区，例如 Asia/Shanghai。");
      // Keep the stored instant when only changing reminder options, including a later DST fold or sub-minute precision.
      const unchangedTime = task.dueDate && timeZone === initialZone && dueDate === taskLocalInput(task.dueDate, initialZone);
      const instant = unchangedTime ? new Date(task.dueDate!) : parseTaskDueDate(dueDate, timeZone);
      if (!instant && (reminderEnabled || repeatRule !== "none")) throw new Error("提醒和重复任务必须设置截止时间。");
      await onSave({ dueDate: instant?.toISOString() ?? null, timeZone, reminderEnabled, repeatRule });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无效的任务时间"); }
  }}>
    <fieldset disabled={disabled} className="space-y-2">
      <label className="block space-y-1"><span>截止时间</span><Input type="datetime-local" value={dueDate} onChange={event => setDueDate(event.target.value)} /></label>
      <label className="block space-y-1"><span>任务时区</span><Input value={timeZone} onChange={event => setTimeZone(event.target.value.trim())} placeholder="Asia/Shanghai" /></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={reminderEnabled} onChange={event => setReminderEnabled(event.target.checked)} />到期桌面通知</label>
      <label className="block space-y-1"><span>重复</span><select aria-label="重复" className="h-8 w-full rounded-md border bg-background px-2" value={repeatRule} onChange={event => setRepeatRule(event.target.value as TaskScheduleInput["repeatRule"])}>
        {Object.entries(repeatLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <p className="text-muted-foreground">完成后创建下一次任务，跳过已错过的日期；月底按最后一天处理。</p>
      {task.repeatGenerated ? <p className="text-muted-foreground">本任务已续建过，重新完成不会再次创建。请在下一次任务中调整重复设置。</p> : null}
      {error ? <p role="alert" className="text-red-600">{error}</p> : null}
      <div className="flex gap-2"><Button size="sm" type="submit">{disabled ? "保存中…" : "保存提醒设置"}</Button><Button size="sm" type="button" variant="ghost" onClick={onCancel}>取消</Button></div>
    </fieldset>
  </form>;
}
