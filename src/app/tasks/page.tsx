"use client";
import { useLocale } from "@/lib/locale/client";

import { t, localizeMessage } from "@/lib/locale";

import { SelectField, SelectOption } from "@/components/ui/select";

import { useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TaskPanel } from "@/features/chat/task-panel";
import { useTasks } from "@/features/chat/use-tasks";
import { chatApi } from "@/features/chat/api-client";
import { repeatLabels } from "@/features/chat/task-schedule-editor";
import { isTaskTimeZone, parseTaskDueDate } from "@/lib/tasks/schedule";

export default function TasksPage() {
  useLocale();
  const tasks = useTasks();
  const [creating, setCreating] = useState(false);
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-7">
      <header className="workspace-page-header flex-col !items-start">
        <h1>{t("settings.schedules.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("ui.tasks.keepTasksAndRemindersHereAnd")}</p>
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
  useLocale();
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [zone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  return (
    <form
      aria-label={t("ui.tasks.newScheduledTask")}
      className="rounded-xl border bg-card p-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (submitting.current) return;
        const values = new FormData(event.currentTarget);
        setError(null);
        try {
          const timeZone = String(values.get("timeZone"));
          if (!isTaskTimeZone(timeZone))
            throw new Error(t("chat.schedule.errorInvalidTimeZone"));
          const due = parseTaskDueDate(String(values.get("dueDate")), timeZone);
          const reminderEnabled = values.get("reminder") === "on";
          const repeatRule = String(values.get("repeatRule"));
          if (!due && (reminderEnabled || repeatRule !== "none"))
            throw new Error(t("ui.tasks.remindersAndRecurringTasksRequireA"));
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
            cause instanceof Error ? cause.message : t("ui.tasks.creationFailedPleaseTryAgain"),
          );
        } finally {
          submitting.current = false;
          setBusy(false);
        }
      }}
    >
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-sm font-medium">{t("ui.tasks.newScheduledTask")}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={busy}
          aria-label={t("ui.tasks.cancelNewTask")}
          onClick={onCancel}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-xs sm:col-span-2">
          {t("ui.activity.events.taskName")}<Input
            name="title"
            required
            maxLength={120}
            autoFocus
            placeholder={t("ui.tasks.forExampleOrganizeThisWeekS")}
          />
        </label>
        <label className="space-y-2 text-xs sm:col-span-2">
          {t("ui.activity.events.taskDescription")}<Input
            name="details"
            maxLength={2000}
            placeholder={t("ui.tasks.addDetailsOptional")}
          />
        </label>
        <label className="space-y-2 text-xs">
          {t("ui.tasks.dueTime")}<Input type="datetime-local" name="dueDate" />
        </label>
        <label className="space-y-2 text-xs">
          {t("settings.schedules.zoneLabel")}<Input name="timeZone" defaultValue={zone} required />
        </label>
        <label className="space-y-2 text-xs">
          {t("tools.createTask.priorityLabel")}<SelectField
            name="priority"
            defaultValue="medium"
            className="block h-9 w-full rounded-md border bg-background px-3"
          >
            <SelectOption value="low">{t("models.thinkingEffort.low")}</SelectOption>
            <SelectOption value="medium">{t("chatMsg.priorityMedium")}</SelectOption>
            <SelectOption value="high">{t("models.thinkingEffort.high")}</SelectOption>
          </SelectField>
        </label>
        <label className="space-y-2 text-xs">
          {t("settings.schedules.intervalLabel")}<SelectField
            name="repeatRule"
            defaultValue="none"
            className="block h-9 w-full rounded-md border bg-background px-3"
          >
            {Object.entries(repeatLabels()).map(([value, label]) => (
              <SelectOption key={value} value={value}>
                {label}
              </SelectOption>
            ))}
          </SelectField>
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" name="reminder" />
          {t("chat.tasks.dueReminder")}</label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("knowledge.cancelEdit")}</Button>
          <Button type="submit">{busy ? t("ui.tasks.creating") : t("tools.createTask.displayName")}</Button>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {localizeMessage(error)}
        </p>
      )}
    </form>
  );
}
