"use client";

import { useRef, useState } from "react";
import { CalendarClock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TaskPanel } from "@/features/chat/task-panel";
import { useTasks } from "@/features/chat/use-tasks";
import { chatApi } from "@/features/chat/api-client";
import { repeatLabels } from "@/features/chat/task-schedule-editor";
import { isTaskTimeZone, parseTaskDueDate } from "@/lib/tasks/schedule";

export default function TasksPage() {
  const tasks = useTasks();
  const [creating, setCreating] = useState(false);
  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 px-6 md:px-10">
      <header className="space-y-2">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <CalendarClock className="h-4 w-4" />
          计划与提醒
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">定时任务</h1>
        <p className="text-sm text-muted-foreground">
          把待办和提醒放在这里，按自己的节奏完成。
        </p>
      </header>
      {creating && (
        <CreateTaskForm
          onCancel={() => setCreating(false)}
          onCreated={async () => {
            tasks.setTaskStatusFilter("all");
            await tasks.loadTasks("all");
            setCreating(false);
          }}
        />
      )}
      <TaskPanel {...tasks} onCreate={() => setCreating(true)} />
    </main>
  );
}

function CreateTaskForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [zone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  return (
    <form
      aria-label="新建定时任务"
      className="rounded-xl border bg-card p-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (submitting.current) return;
        const values = new FormData(event.currentTarget);
        setError(null);
        try {
          const timeZone = String(values.get("timeZone"));
          if (!isTaskTimeZone(timeZone))
            throw new Error("请输入有效的 IANA 时区，例如 Asia/Shanghai。");
          const due = parseTaskDueDate(String(values.get("dueDate")), timeZone);
          const reminderEnabled = values.get("reminder") === "on";
          const repeatRule = String(values.get("repeatRule"));
          if (!due && (reminderEnabled || repeatRule !== "none"))
            throw new Error("提醒或重复任务需要设置时间。");
          submitting.current = true;
          setBusy(true);
          await chatApi.runTool(
            "createTask",
            {
              title: String(values.get("title")),
              details: String(values.get("details")),
              priority: String(values.get("priority")),
              timeZone,
              reminderEnabled,
              repeatRule,
              ...(due ? { dueDate: due.toISOString() } : {}),
            },
            null,
          );
          await onCreated();
        } catch (cause) {
          setError(
            cause instanceof Error ? cause.message : "创建失败，请重试。",
          );
        } finally {
          submitting.current = false;
          setBusy(false);
        }
      }}
    >
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-sm font-medium">新建定时任务</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={busy}
          aria-label="取消新建任务"
          onClick={onCancel}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-xs sm:col-span-2">
          任务名称
          <Input
            name="title"
            required
            maxLength={120}
            autoFocus
            placeholder="例如：整理本周的工作笔记"
          />
        </label>
        <label className="space-y-2 text-xs sm:col-span-2">
          任务说明
          <Input
            name="details"
            maxLength={2000}
            placeholder="补充要做的事情（可选）"
          />
        </label>
        <label className="space-y-2 text-xs">
          到期时间
          <Input type="datetime-local" name="dueDate" />
        </label>
        <label className="space-y-2 text-xs">
          时区
          <Input name="timeZone" defaultValue={zone} required />
        </label>
        <label className="space-y-2 text-xs">
          优先级
          <select
            name="priority"
            defaultValue="medium"
            className="block h-9 w-full rounded-md border bg-background px-3"
          >
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </select>
        </label>
        <label className="space-y-2 text-xs">
          重复
          <select
            name="repeatRule"
            className="block h-9 w-full rounded-md border bg-background px-3"
          >
            {Object.entries(repeatLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" name="reminder" />
          到期提醒
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button type="submit">{busy ? "创建中…" : "创建任务"}</Button>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
