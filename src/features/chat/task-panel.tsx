import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import { useEffect, useState } from "react";
import { TaskScheduleEditor, repeatLabels } from "@/features/chat/task-schedule-editor";
import { cn } from "@/lib/utils/cn";
import {
  ListTodo,
  RefreshCw,
  Trash2
, PanelRightClose, PanelRightOpen } from "lucide-react";
import { formatTaskPriority, formatTaskStatus } from "@/features/chat/message-presentation";
import { t, tf, formatDateTime } from "@/lib/locale";
import type { TaskItem, TaskStatusFilter } from "@/features/chat/types";
import { COLLAPSED_TASK_LIMIT } from "@/features/chat/types";
import type { ChatState } from "@/features/chat/use-chat-state";

type Props = Pick<ChatState, "filteredTasks" | "isLoadingTasks" | "loadTasks" | "setTaskStatusFilter" | "taskStatusFilter" | "taskPanelError" | "visibleTasks" | "updateTaskStatus" | "deleteTask" | "saveTaskSchedule" | "updatingTaskIds" | "hasHiddenTasks" | "setIsTaskListExpanded" | "isTaskListExpanded" | "panelVisibility" | "togglePanel">;
export function TaskPanel({ filteredTasks, isLoadingTasks, loadTasks, setTaskStatusFilter, taskStatusFilter, taskPanelError, visibleTasks, updateTaskStatus, deleteTask, saveTaskSchedule, updatingTaskIds, hasHiddenTasks, setIsTaskListExpanded, isTaskListExpanded, panelVisibility, togglePanel }: Props) {
  const railOpen = panelVisibility?.tasks !== false;
  const [now, setNow] = useState(0);
  // A status filter is a different question, so it earns a fresh first paint;
  // re-running the same filter never does.
  const awaitingFirstTaskLoad = useAwaitingFirstLoad(isLoadingTasks, taskStatusFilter);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    refresh();
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  return (<aside
    aria-label={t("chat.tasks.title")}
    className={cn(
      "w-full shrink-0 xl:sticky xl:top-[3.75rem] xl:flex xl:max-h-[calc(100vh-5rem)] xl:flex-col xl:overflow-y-auto xl:overscroll-contain xl:animate-panel-in-right",
      // Matches the conversation rail: the width animates so this one and that
      // one collapse with the same motion.
      "xl:transition-[width] xl:duration-[--dur-base] xl:ease-[--ease-out]",
      railOpen ? "xl:w-[17rem]" : "xl:w-12",
    )}
  >
    {!railOpen ? (
      <div className="hidden xl:flex xl:flex-col xl:items-center xl:gap-2 xl:pt-5">
        <Button
          aria-expanded={false}
          aria-label={t("chat.tasks.expandRail")}
          className="h-7 w-7 px-0"
          onClick={() => togglePanel("tasks")}
          size="icon"
          title={t("chat.tasks.expandRail")}
          type="button"
          variant="ghost"
        >
          <PanelRightOpen aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>
    ) : (
    <>
    <Card className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden rounded-none border-0 border-l border-border bg-transparent shadow-none xl:max-h-[calc(100vh-2.5rem)] xl:flex-1 xl:pl-5">
      <CardHeader className="shrink-0 border-b pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base tracking-title">
            <ListTodo aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
            {t("chat.tasks.title")}
          </CardTitle>
          <Button
            aria-expanded={railOpen}
            aria-label={t("chat.tasks.collapseRail")}
            className="h-7 w-7 shrink-0 px-0"
            onClick={() => togglePanel("tasks")}
            size="icon"
            title={t("chat.tasks.collapseRail")}
            type="button"
            variant="ghost"
          >
            <PanelRightClose aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
        <CardDescription>{t("chat.tasks.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="chat-list-scroll min-h-0 space-y-5 overflow-y-auto p-4 pr-3">
        <section className="space-y-3" data-testid="task-panel">
          <p className="text-[11px] leading-4 text-muted-foreground">{t("chat.tasks.desktopNotice")}</p>
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold tracking-label">{t("chat.tasks.listTitle")}</h3>
              <p className="text-[11px] text-muted-foreground">
                {filteredTasks.length} {t("chat.tasks.matchCountUnit")}
              </p>
            </div>
            <Button
              aria-label={t("chat.tasks.refresh")}
              disabled={isLoadingTasks}
              onClick={() => void loadTasks()}
              size="icon"
              type="button"
              variant="ghost"
            >
              <RefreshCw aria-hidden="true" className={cn("h-4 w-4", isLoadingTasks ? "animate-spin" : "")} />
            </Button>
          </div>

          <Select
            onValueChange={(value) => setTaskStatusFilter(value as TaskStatusFilter)}
            value={taskStatusFilter}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("chat.tasks.filterAll")}</SelectItem>
              <SelectItem value="todo">{t("chat.tasks.statusTodo")}</SelectItem>
              <SelectItem value="in_progress">{t("chat.tasks.statusInProgress")}</SelectItem>
              <SelectItem value="done">{t("chat.tasks.statusDone")}</SelectItem>
            </SelectContent>
          </Select>

          {taskPanelError ? (
            <p className="rounded-lg bg-destructive/5 px-2 py-1.5 text-xs text-destructive shadow-hairline">
              {taskPanelError}
            </p>
          ) : null}

          <div className="space-y-2">
            {awaitingFirstTaskLoad ? (
              <div className="space-y-2">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : filteredTasks.length === 0 ? (
              <p className="empty-state !p-3 !text-left text-[13px]">
                {t("chat.tasks.emptyFiltered")}
              </p>
            ) : (
              visibleTasks.map((task) => (
                <div
                  className="animate-row-in rounded-lg bg-elevated p-3 shadow-hairline transition-[box-shadow,transform] duration-[--dur-base] ease-[--ease-out] hover:-translate-y-px hover:shadow-card"
                  data-testid="task-item"
                  key={task.id}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium tracking-label">{task.title}</p>
                      {task.details ? (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.details}</p>
                      ) : null}
                    </div>
                    <Badge variant={task.status === "done" ? "success" : "outline"}>
                      {formatTaskStatus(task.status)}
                    </Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span>{tf("chat.tasks.priorityLabel", { priority: formatTaskPriority(task.priority) })}</span>
                    {task.dueDate ? <span>{tf("chat.tasks.dueLabel", { value: formatDateTime(task.dueDate, { timeZone: task.timeZone ?? "UTC" }), timeZone: task.timeZone ?? "UTC" })}</span> : null}
                    {task.dueDate && task.status !== "done" && Date.parse(task.dueDate) <= now ? <Badge variant="danger">{t("chat.tasks.overdue")}</Badge> : null}
                    {task.reminderEnabled ? <span>{t("chat.tasks.dueReminder")}</span> : null}
                    {task.repeatRule && task.repeatRule !== "none" ? <span>{repeatLabels[task.repeatRule]} · {t("chat.tasks.repeatNext")}</span> : null}
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <Select
                      disabled={updatingTaskIds.includes(task.id)}
                      onValueChange={(value) => void updateTaskStatus(task.id, value as TaskItem["status"])}
                      value={task.status}
                    >
                      <SelectTrigger aria-label={`${t("chat.tasks.statusLabel")} ${task.title}`} className="h-8 flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="todo">{t("chat.tasks.statusTodo")}</SelectItem>
                        <SelectItem value="in_progress">{t("chat.tasks.statusInProgress")}</SelectItem>
                        <SelectItem value="done">{t("chat.tasks.statusDone")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      aria-label={`${t("chat.tasks.deleteLabel")} ${task.title}`}
                      disabled={updatingTaskIds.includes(task.id)}
                      onClick={() => void deleteTask(task.id)}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 aria-hidden="true" className="h-4 w-4" />
                    </Button>
                  </div>
                  <TaskScheduleEditor task={task} onSave={saveTaskSchedule} disabled={updatingTaskIds.includes(task.id)} />
                </div>
              ))
            )}
          </div>

          {hasHiddenTasks ? (
            <Button
              className="w-full"
              onClick={() => setIsTaskListExpanded((prev) => !prev)}
              type="button"
              variant="secondary"
            >
              {isTaskListExpanded ? t("chat.tasks.collapse") : tf("chat.common.expandMore", { count: filteredTasks.length - COLLAPSED_TASK_LIMIT })}
            </Button>
          ) : null}
        </section>
      </CardContent>
    </Card>
    </>
  )}
  </aside>);
}
