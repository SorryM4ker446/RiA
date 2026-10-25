"use client";
import { useLocale } from "@/lib/locale/client";
import { t, tf, formatDateTime } from "@/lib/locale";
import { Button } from "@/components/ui/button";
import { SelectField, SelectOption } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Reveal } from "@/components/ui/reveal";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyDescription,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import { useEffect, useState } from "react";
import {
  TaskScheduleEditor,
  repeatLabels,
} from "@/features/tasks/task-schedule-editor";
import { cn } from "@/lib/utils/cn";
import { ListTodo, RefreshCw, Trash2, Bell } from "lucide-react";
import { Status } from "@/components/ui/status";
import { ListHead } from "@/components/layout/page-toolbar";
import { formatTaskPriority } from "@/features/chat/message-presentation";
import type { TaskItem, TaskStatusFilter } from "@/features/chat/types";
import { COLLAPSED_TASK_LIMIT } from "@/features/chat/types";
import type { useTasks } from "@/features/tasks/use-tasks";
import { removalKey } from "@/lib/ui/removal";

type Props = ReturnType<typeof useTasks>;
export function TaskPanel({
  filteredTasks,
  isLoadingTasks,
  loadTasks,
  setTaskStatusFilter,
  taskStatusFilter,
  taskPanelError,
  visibleTasks,
  updateTaskStatus,
  deleteTask,
  saveTaskSchedule,
  updatingTaskIds,
  hasHiddenTasks,
  setIsTaskListExpanded,
  isTaskListExpanded,
  isTaskFilterPending,
}: Props) {
  useLocale();
  const [now, setNow] = useState(0);
  const awaitingFirstTaskLoad = useAwaitingFirstLoad(isLoadingTasks, "tasks");
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    refresh();
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  const filters: Array<{ value: TaskStatusFilter; label: string }> = [
    { value: "all", label: t("chat.tasks.filterAll") },
    { value: "todo", label: t("chat.tasks.statusTodo") },
    { value: "in_progress", label: t("chat.tasks.statusInProgress") },
    { value: "done", label: t("chat.tasks.statusDone") },
  ];
  return (
    <section
      aria-label={t("ui.chat.task-panel.taskManagement")}
      className="flex flex-col gap-3"
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex items-center gap-2">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            {t("chat.tasks.title")}
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {filteredTasks.length}
            </span>
          </h2>
          <div className="flex gap-0.5">
            <Button
              aria-label={t("chat.tasks.refresh")}
              disabled={isLoadingTasks}
              onClick={() => void loadTasks()}
              size="icon-sm"
              variant="ghost"
            >
              <RefreshCw className={cn(isLoadingTasks && "animate-spin")} />
            </Button>
          </div>
        </div>
        <ToggleGroup
          type="single"
          value={taskStatusFilter}
          size="sm"
          onValueChange={(value) => {
            if (value) setTaskStatusFilter(value as TaskStatusFilter);
          }}
          aria-label={t("chat.tasks.listTitle")}
          className="order-last w-full flex-wrap justify-start gap-2 sm:order-none sm:w-auto"
        >
          {filters.map((filter) => (
            <ToggleGroupItem
              key={filter.value}
              value={filter.value}
              className="shrink-0 whitespace-nowrap"
            >
              {filter.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </header>
      <section
        data-testid="task-panel"
        aria-busy={isLoadingTasks}
        className="flex flex-col gap-3"
      >
        <Reveal>
          {taskPanelError ? (
            <Alert variant="destructive">
              <AlertDescription>{taskPanelError}</AlertDescription>
            </Alert>
          ) : null}
        </Reveal>
        {awaitingFirstTaskLoad ? (
          <div
            role="status"
            aria-label={t("ui.chat.task-panel.loadTasks")}
            className="flex flex-col gap-2"
          >
            <Skeleton className="h-14 rounded-lg" />
            <Skeleton className="h-14 rounded-lg" />
          </div>
        ) : filteredTasks.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia>
                <ListTodo aria-hidden="true" />
              </EmptyMedia>
              <EmptyDescription>
                {t("chat.tasks.emptyFiltered")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="item-list" style={{ "--cols": "16px minmax(0, 1fr) 3rem 6.5rem 5.5rem 2rem 2rem", "--cols-narrow": "16px minmax(0, 1fr) 5.5rem 2rem 2rem" } as React.CSSProperties}>
            <ListHead><span /><span>{t("ui.columns.title")}</span><span className="col-optional">{t("ui.columns.priority")}</span><span className="col-optional">{t("ui.columns.due")}</span><span className="pl-2">{t("ui.columns.status")}</span><span /><span /></ListHead>
            {visibleTasks.map((task) => {
            const busy =
              isTaskFilterPending || updatingTaskIds.includes(task.id);
            const overdue = Boolean(task.dueDate && task.status !== "done" && Date.parse(task.dueDate) <= now);
            return (
              <article
                key={task.id}
                {...removalKey(task.id)}
                data-testid="task-item"
                aria-label={task.title}
                className="item-row item-row-stack task-row"
              >
                {/* One line per task: done, what, when, state. The schedule form opens on its own line beneath. */}
                <div className="data-row">
                  <TaskCompletionCheckbox
                    task={task}
                    disabled={busy}
                    update={updateTaskStatus}
                  />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <h3
                      className={cn(
                        "break-words text-sm font-medium transition-colors duration-[--dur-base]",
                        task.status === "done" &&
                          "text-muted-foreground line-through",
                      )}
                    >
                      {task.title}
                    </h3>
                    <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      {overdue && <Status tone="danger">{t("chat.tasks.overdue")}</Status>}
                      {task.reminderEnabled && (
                        <Bell
                          role="img"
                          aria-hidden={false}
                          aria-label={t("chat.tasks.dueReminder")}
                          className="h-3 w-3"
                        />
                      )}
                      {task.repeatRule && task.repeatRule !== "none" && (
                        <span>
                          {repeatLabels()[task.repeatRule]} ·{" "}
                          {t("chat.tasks.repeatNext")}
                        </span>
                      )}
                      {task.details && <span className="min-w-0 truncate">{task.details}</span>}
                    </p>
                  </div>
                  <span className={cn("col-meta col-optional", task.priority === "high" && "text-foreground")}>
                    {formatTaskPriority(task.priority)}
                  </span>
                  <span
                    className={cn("col-meta col-optional", overdue && "text-destructive")}
                    title={task.dueDate ? tf("chat.tasks.dueLabel", { value: formatDateTime(task.dueDate, { timeZone: task.timeZone ?? "UTC" }), timeZone: task.timeZone ?? "UTC" }) : undefined}
                  >
                    {task.dueDate ? formatDateTime(task.dueDate, { timeZone: task.timeZone ?? "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                  </span>
                  <SelectField
                    disabled={busy}
                    value={task.status}
                    onValueChange={(value) =>
                      void updateTaskStatus(
                        task.id,
                        value as TaskItem["status"],
                      )
                    }
                    aria-label={`${t("chat.tasks.statusLabel")} ${task.title}`}
                    size="sm"
                    variant="ghost"
                    className="w-auto min-w-0"
                  >
                    <SelectOption value="todo">
                      {t("chat.tasks.statusTodo")}
                    </SelectOption>
                    <SelectOption value="in_progress">
                      {t("chat.tasks.statusInProgress")}
                    </SelectOption>
                    <SelectOption value="done">
                      {t("chat.tasks.statusDone")}
                    </SelectOption>
                  </SelectField>
                  <Button
                    aria-label={`${t("chat.tasks.deleteLabel")} ${task.title}`}
                    disabled={busy}
                    onClick={() => void deleteTask(task.id)}
                    size="icon-sm"
                    variant="ghost"
                    className="task-delete shrink-0"
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                  <TaskScheduleEditor
                    task={task}
                    onSave={saveTaskSchedule}
                    disabled={busy}
                  />
                </div>
              </article>
            );
          })}</div>
        )}
        {hasHiddenTasks && (
          <Button
            className="self-start"
            size="sm"
            variant="ghost"
            onClick={() => setIsTaskListExpanded((previous) => !previous)}
          >
            {isTaskListExpanded
              ? t("chat.tasks.collapse")
              : tf("chat.common.expandMore", {
                  count: filteredTasks.length - COLLAPSED_TASK_LIMIT,
                })}
          </Button>
        )}
      </section>
      <details className="shrink-0 px-1 text-[11px] leading-5 text-muted-foreground">
        <summary className="cursor-pointer">
          {t("chat.tasks.reminderInfo")}
        </summary>
        <p className="mt-2">{t("chat.tasks.desktopNotice")}</p>
      </details>
    </section>
  );
}

function TaskCompletionCheckbox({
  task,
  disabled,
  update,
}: {
  task: TaskItem;
  disabled: boolean;
  update: Props["updateTaskStatus"];
}) {
  useLocale();
  const [value, setValue] = useState({
    status: task.status,
    checked: task.status === "done",
  });
  if (value.status !== task.status)
    setValue({ status: task.status, checked: task.status === "done" });
  return (
    <Checkbox
      aria-label={tf("chat.tasks.complete", { title: task.title })}
      checked={value.checked}
      disabled={disabled}
      className="mt-1"
      onCheckedChange={async (next) => {
        const checked = next === true;
        setValue((current) => ({ ...current, checked }));
        if (!(await update(task.id, checked ? "done" : "todo")))
          setValue((current) => ({
            ...current,
            checked: current.status === "done",
          }));
      }}
    />
  );
}
