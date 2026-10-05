import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { t, tf, formatDateTime } from "@/lib/locale";
import type { TaskItem, TaskStatusFilter } from "@/features/chat/types";
import { COLLAPSED_TASK_LIMIT } from "@/features/chat/types";
import type { useTasks } from "@/features/chat/use-tasks";

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
}: Props) {
  const [now, setNow] = useState(0);
  const awaitingFirstTaskLoad = useAwaitingFirstLoad(
    isLoadingTasks,
    taskStatusFilter,
  );
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
    <section aria-label="任务管理" className="space-y-5">
      <header className="flex flex-wrap items-center gap-4">
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
              className="h-6 w-6 text-muted-foreground"
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", isLoadingTasks && "animate-spin")}
              />
            </Button>
          </div>
        </div>
        <div
          aria-label={t("chat.tasks.listTitle")}
          className="flex gap-1 rounded-lg bg-muted/70 p-1"
        >
          {filters.map((filter) => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={taskStatusFilter === filter.value}
              className={cn(
                "min-w-0 flex-1 whitespace-nowrap rounded-md px-1 py-1.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                taskStatusFilter === filter.value
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setTaskStatusFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          className="ml-auto h-9 gap-2 text-xs"
          onClick={onCreate}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("chat.tasks.create")}
        </Button>
      </header>
      <section
        data-testid="task-panel"
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
      >
        {taskPanelError && (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive"
          >
            {taskPanelError}
          </p>
        )}
        {awaitingFirstTaskLoad ? (
          <div role="status" aria-label="加载任务" className="space-y-2">
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <ListTodo className="mx-auto mb-3 h-7 w-7 text-muted-foreground/35" />
            <p className="text-xs leading-6 text-muted-foreground">
              {t("chat.tasks.emptyFiltered")}
            </p>
          </div>
        ) : (
          visibleTasks.map((task) => {
            const busy = updatingTaskIds.includes(task.id);
            return (
              <article
                key={task.id}
                data-testid="task-item"
                className="group rounded-xl border border-border/60 bg-card/40 p-3 transition-colors hover:border-foreground/20"
              >
                <div className="flex items-start gap-2.5">
                  <TaskCompletionCheckbox
                    task={task}
                    disabled={busy}
                    update={updateTaskStatus}
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "break-words text-[13px] font-medium leading-5",
                        task.status === "done" &&
                          "text-muted-foreground line-through",
                      )}
                    >
                      {task.title}
                    </p>
                    {task.details && (
                      <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-muted-foreground">
                        {task.details}
                      </p>
                    )}
                  </div>
                  <Button
                    aria-label={`${t("chat.tasks.deleteLabel")} ${task.title}`}
                    disabled={busy}
                    onClick={() => void deleteTask(task.id)}
                    size="icon"
                    variant="ghost"
                    className="task-delete -mr-1 h-6 w-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="rounded bg-muted/70 px-1.5 py-0.5">
                    {formatTaskPriority(task.priority)}
                  </span>
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
                      {repeatLabels[task.repeatRule]} ·{" "}
                      {t("chat.tasks.repeatNext")}
                    </span>
                  )}
                </div>
                <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-2 border-t border-border/40 pt-2">
                  <Select
                    disabled={busy}
                    value={task.status}
                    onValueChange={(value) =>
                      void updateTaskStatus(
                        task.id,
                        value as TaskItem["status"],
                      )
                    }
                  >
                    <SelectTrigger
                      aria-label={`${t("chat.tasks.statusLabel")} ${task.title}`}
                      className="h-7 w-auto gap-2 border-0 bg-transparent px-1 text-[11px] shadow-none"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="todo">
                        {t("chat.tasks.statusTodo")}
                      </SelectItem>
                      <SelectItem value="in_progress">
                        {t("chat.tasks.statusInProgress")}
                      </SelectItem>
                      <SelectItem value="done">
                        {t("chat.tasks.statusDone")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <TaskScheduleEditor
                    task={task}
                    onSave={saveTaskSchedule}
                    disabled={busy}
                  />
                </div>
              </article>
            );
          })
        )}
        {hasHiddenTasks && (
          <Button
            className="h-8 w-full text-xs"
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
  const [value, setValue] = useState({
    status: task.status,
    checked: task.status === "done",
  });
  if (value.status !== task.status)
    setValue({ status: task.status, checked: task.status === "done" });
  return (
    <input
      aria-label={tf("chat.tasks.complete", { title: task.title })}
      type="checkbox"
      checked={value.checked}
      disabled={disabled}
      className="mt-1 h-3.5 w-3.5 shrink-0 accent-foreground"
      onChange={async (event) => {
        const checked = event.target.checked;
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
