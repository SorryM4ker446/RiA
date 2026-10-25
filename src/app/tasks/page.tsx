"use client";
import { useLocale } from "@/lib/locale/client";

import { t, localizeMessage } from "@/lib/locale";

import { SelectField, SelectOption } from "@/components/ui/select";

import { useRef, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Reveal } from "@/components/ui/reveal";
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
import { TaskPanel } from "@/features/tasks/task-panel";
import { useTasks } from "@/features/tasks/use-tasks";
import { chatApi } from "@/features/chat/api-client";
import { repeatLabels } from "@/features/tasks/task-schedule-editor";
import { isTaskTimeZone, parseTaskDueDate } from "@/lib/tasks/schedule";

export default function TasksPage() {
  useLocale();
  const tasks = useTasks();
  const [creating, setCreating] = useState(false);
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-7">
      <PageHeader
        title={t("tasks.title")}
        description={t("ui.tasks.keepTasksAndRemindersHereAnd")}
        actions={
          <Button size="sm" disabled={creating} onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            {t("chat.tasks.create")}
          </Button>
        }
      />
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
      <QuickAddTask
        onCreated={async () => {
          tasks.setTaskStatusFilter("all");
          await tasks.loadTasks("all");
        }}
      />
      <TaskPanel {...tasks} />
    </main>
  );
}

/** A task with only a title, saved on Enter; the full form is for dates, reminders and repeats. */
function QuickAddTask({ onCreated }: { onCreated: () => Promise<void> }) {
  useLocale();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  return (
    <form
      aria-label={t("tasks.quickAddLabel")}
      className="-mb-2 flex flex-col"
      onSubmit={async (event) => {
        event.preventDefault();
        const value = title.trim();
        if (!value || busy) return;
        setBusy(true);
        setError(null);
        try {
          await chatApi.createTask({
            title: value,
            priority: "medium",
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            reminderEnabled: false,
            repeatRule: "none",
          });
          setTitle("");
          await onCreated();
          toast(t("tasks.quickAdded"));
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : t("ui.tasks.creationFailedPleaseTryAgain"));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="toolbar-search">
        <Plus aria-hidden="true" />
        <input
          type="text"
          aria-label={t("tasks.quickAddLabel")}
          placeholder={t("tasks.quickAddPlaceholder")}
          maxLength={120}
          value={title}
          // Read-only rather than disabled while saving, so focus stays for the next task.
          readOnly={busy}
          aria-busy={busy}
          enterKeyHint="done"
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <Reveal>
        {error ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {localizeMessage(error)}
          </p>
        ) : null}
      </Reveal>
    </form>
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
    <Card className="surface-enter">
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
            await chatApi.createTask({
              title: String(values.get("title")),
              details: String(values.get("details")),
              priority,
              timeZone,
              reminderEnabled,
              repeatRule,
              ...(due ? { dueDate: due.toISOString() } : {}),
            });
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
              {/* The device's time zone is almost always right, so it waits behind "more options". */}
              <details className="settings-disclosure sm:col-span-2">
                <summary className="settings-disclosure-trigger">
                  {t("tasks.moreOptions")}
                  <ChevronDown aria-hidden="true" className="ml-auto size-4" />
                </summary>
                <Field className="gap-2 pt-3 sm:max-w-sm" data-disabled={busy}>
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
              </details>
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
          <Reveal>
            {error ? (
              <Alert variant="destructive" className="mt-4">
                <AlertDescription>{localizeMessage(error)}</AlertDescription>
              </Alert>
            ) : null}
          </Reveal>
        </CardContent>
        <CardFooter className="justify-end gap-2 border-t pt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={busy}
          >
            {t("knowledge.cancelEdit")}
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? t("ui.tasks.creating") : t("tools.createTask.displayName")}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
