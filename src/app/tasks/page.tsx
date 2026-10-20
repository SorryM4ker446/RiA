"use client";
import { useLocale } from "@/lib/locale/client";

import { t, localizeMessage } from "@/lib/locale";

import { SelectField, SelectOption } from "@/components/ui/select";

import { useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field";
import { TaskDateTimeField } from "@/features/tasks/task-date-time-field";
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
          {t("ui.tasks.keepTasksAndRemindersHereAnd")}
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
  useLocale();
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState("medium");
  const [repeatRule, setRepeatRule] = useState("none");
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [zone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  return (
    <Card>
      <form
        aria-label={t("ui.tasks.newScheduledTask")}
        className="flex flex-col"
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current) return;
          const values = new FormData(event.currentTarget);
          setError(null);
          try {
            const timeZone = String(values.get("timeZone"));
            if (!isTaskTimeZone(timeZone))
              throw new Error(t("chat.schedule.errorInvalidTimeZone"));
            const due = parseTaskDueDate(dueDate, timeZone);
            if (!due && (reminderEnabled || repeatRule !== "none"))
              throw new Error(t("ui.tasks.remindersAndRecurringTasksRequireA"));
            submitting.current = true;
            setBusy(true);
            await chatApi.runTool(
              "createTask",
              {
                title: String(values.get("title")),
                details: String(values.get("details")),
                priority,
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
              cause instanceof Error
                ? cause.message
                : t("ui.tasks.creationFailedPleaseTryAgain"),
            );
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle>{t("ui.tasks.newScheduledTask")}</CardTitle>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            aria-label={t("ui.tasks.cancelNewTask")}
            onClick={onCancel}
          >
            <X aria-hidden="true" />
          </Button>
        </CardHeader>
        <CardContent>
          <FieldSet disabled={busy}>
            <FieldGroup className="grid gap-5 sm:grid-cols-2">
              <Field className="gap-2 sm:col-span-2" data-disabled={busy}>
                <FieldLabel htmlFor="task-title">
                  {t("ui.activity.events.taskName")}
                </FieldLabel>
                <Input
                  id="task-title"
                  name="title"
                  required
                  maxLength={120}
                  autoFocus
                  placeholder={t("ui.tasks.forExampleOrganizeThisWeekS")}
                />
              </Field>
              <Field className="gap-2 sm:col-span-2" data-disabled={busy}>
                <FieldLabel htmlFor="task-details">
                  {t("ui.activity.events.taskDescription")}
                </FieldLabel>
                <Textarea
                  id="task-details"
                  name="details"
                  maxLength={2000}
                  placeholder={t("ui.tasks.addDetailsOptional")}
                />
              </Field>
              <TaskDateTimeField
                label={t("ui.tasks.dueTime")}
                value={dueDate}
                onChange={setDueDate}
                disabled={busy}
              />
              <Field className="gap-2" data-disabled={busy}>
                <FieldLabel htmlFor="task-time-zone">
                  {t("settings.schedules.zoneLabel")}
                </FieldLabel>
                <Input
                  id="task-time-zone"
                  name="timeZone"
                  defaultValue={zone}
                  required
                />
              </Field>
              <Field className="gap-2" data-disabled={busy}>
                <FieldLabel htmlFor="task-priority">
                  {t("tools.createTask.priorityLabel")}
                </FieldLabel>
                <SelectField
                  id="task-priority"
                  value={priority}
                  onValueChange={setPriority}
                  disabled={busy}
                  className="w-full"
                >
                  <SelectOption value="low">
                    {t("models.thinkingEffort.low")}
                  </SelectOption>
                  <SelectOption value="medium">
                    {t("chatMsg.priorityMedium")}
                  </SelectOption>
                  <SelectOption value="high">
                    {t("models.thinkingEffort.high")}
                  </SelectOption>
                </SelectField>
              </Field>
              <Field className="gap-2" data-disabled={busy}>
                <FieldLabel htmlFor="task-repeat">
                  {t("settings.schedules.intervalLabel")}
                </FieldLabel>
                <SelectField
                  id="task-repeat"
                  value={repeatRule}
                  onValueChange={setRepeatRule}
                  disabled={busy}
                  className="w-full"
                >
                  {Object.entries(repeatLabels()).map(([value, label]) => (
                    <SelectOption key={value} value={value}>
                      {label}
                    </SelectOption>
                  ))}
                </SelectField>
              </Field>
              <FieldDescription className="sm:col-span-2">
                {t("tasks.scheduleHint")}
              </FieldDescription>
              <Field
                orientation="horizontal"
                data-disabled={busy}
                className="sm:col-span-2"
              >
                <Checkbox
                  id="task-reminder"
                  checked={reminderEnabled}
                  onCheckedChange={(value) =>
                    setReminderEnabled(value === true)
                  }
                  disabled={busy}
                />
                <FieldLabel htmlFor="task-reminder">
                  {t("chat.tasks.dueReminder")}
                </FieldLabel>
              </Field>
            </FieldGroup>
          </FieldSet>
          {error && (
            <Alert variant="destructive" className="mt-4">
              <AlertDescription>{localizeMessage(error)}</AlertDescription>
            </Alert>
          )}
        </CardContent>
        <CardFooter className="justify-end gap-2 border-t pt-4">
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={busy}
          >
            {t("knowledge.cancelEdit")}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t("ui.tasks.creating") : t("tools.createTask.displayName")}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
