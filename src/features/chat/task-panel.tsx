"use client";
import { useLocale } from "@/lib/locale/client";
import { t, tf, formatDateTime } from "@/lib/locale";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SelectField, SelectOption } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
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
} from "@/features/chat/task-schedule-editor";
import { cn } from "@/lib/utils/cn";
import { ListTodo, RefreshCw, Trash2, Plus, Bell } from "lucide-react";
import { formatTaskPriority } from "@/features/chat/message-presentation";
import type { TaskItem, TaskStatusFilter } from "@/features/chat/types";
import { COLLAPSED_TASK_LIMIT } from "@/features/chat/types";
import type { useTasks } from "@/features/chat/use-tasks";
import { removalKey } from "@/lib/ui/removal";

type Props = ReturnType<typeof useTasks> & { onCreate: () => void };
export function TaskPanel({
  onCreate,
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
      className="flex flex-col gap-5"
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex items-center justify-between gap-2">
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
              size="icon"
              variant="ghost"
              className="size-8"
            >
              <RefreshCw className={cn(isLoadingTasks && "animate-spin")} />
            </Button>
          </div>
        </div>
        <ToggleGroup
          type="single"
          value={taskStatusFilter}
          size="sm"
          variant="outline"
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
        <Button variant="outline" className="ml-auto" onClick={onCreate}>
          <Plus data-icon="inline-start" aria-hidden="true" />
          {t("chat.tasks.create")}
        </Button>
      </header>
      <section
        data-testid="task-panel"
        aria-busy={isLoadingTasks}
        className="grid min-h-48 items-start gap-3 sm:grid-cols-2 xl:grid-cols-3"
      >
        {taskPanelError && (
          <Alert variant="destructive" className="col-span-full">
            <AlertDescription>{taskPanelError}</AlertDescription>
          </Alert>
        )}
        {awaitingFirstTaskLoad ? (
          <div
            role="status"
            aria-label={t("ui.chat.task-panel.loadTasks")}
            className="col-span-full grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
          >
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
          </div>
        ) : filteredTasks.length === 0 ? (
          <Empty className="col-span-full">
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
          visibleTasks.map((task) => {
            const busy =
              isTaskFilterPending || updatingTaskIds.includes(task.id);
            return (
              <Card
                role="article"
                key={task.id}
                {...removalKey(task.id)}
                data-testid="task-item"
                className="group flex min-w-0 flex-col"
              >
                <CardHeader className="flex-row items-start gap-3 p-4">
                  <TaskCompletionCheckbox
                    task={task}
                    disabled={busy}
                    update={updateTaskStatus}
                  />
                  <div className="min-w-0 flex-1">
                    <CardTitle
                      className={cn(
                        "break-words",
                        task.status === "done" &&
                          "text-muted-foreground line-through",
                      )}
                    >
                      {task.title}
                    </CardTitle>
                    {task.details && (
                      <CardDescription className="mt-1 line-clamp-2 break-words">
                        {task.details}
                      </CardDescription>
                    )}
                  </div>
                  <Button
                    aria-label={`${t("chat.tasks.deleteLabel")} ${task.title}`}
                    disabled={busy}
                    onClick={() => void deleteTask(task.id)}
                    size="icon-sm"
                    variant="ghost"
                    className="task-delete -mr-1 shrink-0"
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-2 px-4 pb-4 text-xs text-muted-foreground">
                  <Badge variant="secondary">
                    {formatTaskPriority(task.priority)}
                  </Badge>
                  {task.dueDate && (
                    <span className="break-words">
                      {tf("chat.tasks.dueLabel", {
                        value: formatDateTime(task.dueDate, {
                          timeZone: task.timeZone ?? "UTC",
                        }),
                        timeZone: task.timeZone ?? "UTC",
                      })}
                    </span>
                  )}
                  {task.dueDate &&
                    task.status !== "done" &&
                    Date.parse(task.dueDate) <= now && (
                      <Badge variant="danger">{t("chat.tasks.overdue")}</Badge>
                    )}
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
                </CardContent>
                <CardFooter className="mt-auto grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 border-t px-3 py-2">
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
                    className="min-w-0"
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
                  <TaskScheduleEditor
                    task={task}
                    onSave={saveTaskSchedule}
                    disabled={busy}
                  />
                </CardFooter>
              </Card>
            );
          })
        )}
        {hasHiddenTasks && (
          <Button
            className="col-span-full w-full"
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
      <details className="shrink-0 border-t border-border/50 px-4 py-3 text-[10px] leading-5 text-muted-foreground">
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
