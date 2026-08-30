import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useEffect, useState } from "react";
import { TaskScheduleEditor, repeatLabels } from "@/features/chat/task-schedule-editor";
import { cn } from "@/lib/utils/cn";
import {
  ListTodo,
  RefreshCw,
  Trash2
} from "lucide-react";
import { formatTaskPriority, formatTaskStatus } from "@/features/chat/message-presentation";
import type { TaskItem, TaskStatusFilter } from "@/features/chat/types";
import { COLLAPSED_TASK_LIMIT } from "@/features/chat/types";
import type { ChatState } from "@/features/chat/use-chat-state";

type Props = Pick<ChatState, "filteredTasks" | "isLoadingTasks" | "loadTasks" | "setTaskStatusFilter" | "taskStatusFilter" | "taskPanelError" | "tasks" | "visibleTasks" | "updateTaskStatus" | "deleteTask" | "saveTaskSchedule" | "updatingTaskIds" | "hasHiddenTasks" | "setIsTaskListExpanded" | "isTaskListExpanded">;
export function TaskPanel({ filteredTasks, isLoadingTasks, loadTasks, setTaskStatusFilter, taskStatusFilter, taskPanelError, tasks, visibleTasks, updateTaskStatus, deleteTask, saveTaskSchedule, updatingTaskIds, hasHiddenTasks, setIsTaskListExpanded, isTaskListExpanded }: Props) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    refresh();
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  return (<aside className="w-full shrink-0 xl:sticky xl:top-6 xl:max-h-[calc(100vh-3rem)] xl:w-80">
    <Card className="glass-surface flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden xl:max-h-[calc(100vh-3rem)]">
      <CardHeader className="shrink-0 border-b border-border/70 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ListTodo className="h-4 w-4 text-primary" />
          任务
        </CardTitle>
        <CardDescription>到期提醒与重复任务</CardDescription>
      </CardHeader>
      <CardContent className="chat-list-scroll min-h-0 space-y-5 overflow-y-auto p-4 pr-3">
        <section className="space-y-3" data-testid="task-panel">
          <p className="text-[11px] text-muted-foreground">系统通知仅在桌面应用运行时发送；关闭后下次启动补查。网页仅显示到期状态。</p>
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">任务列表</h3>
              <p className="text-[11px] text-muted-foreground">
                {filteredTasks.length} 个匹配任务
              </p>
            </div>
            <Button
              aria-label="刷新任务"
              disabled={isLoadingTasks}
              onClick={() => void loadTasks()}
              size="icon"
              type="button"
              variant="ghost"
            >
              <RefreshCw className={cn("h-4 w-4", isLoadingTasks ? "animate-spin" : "")} />
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
              <SelectItem value="all">全部任务</SelectItem>
              <SelectItem value="todo">待处理</SelectItem>
              <SelectItem value="in_progress">进行中</SelectItem>
              <SelectItem value="done">已完成</SelectItem>
            </SelectContent>
          </Select>

          {taskPanelError ? (
            <p className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-600 dark:text-red-300">
              {taskPanelError}
            </p>
          ) : null}

          <div className="space-y-2">
            {isLoadingTasks && tasks.length === 0 ? (
              <div className="space-y-2">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : filteredTasks.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                当前筛选下暂无任务。
              </p>
            ) : (
              visibleTasks.map((task) => (
                <div
                  className="rounded-md border border-border/80 bg-background/50 p-3 transition-colors duration-200"
                  data-testid="task-item"
                  key={task.id}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{task.title}</p>
                      {task.details ? (
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.details}</p>
                      ) : null}
                    </div>
                    <Badge variant={task.status === "done" ? "success" : "outline"}>
                      {formatTaskStatus(task.status)}
                    </Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span>优先级：{formatTaskPriority(task.priority)}</span>
                    {task.dueDate ? <span>截止：{new Date(task.dueDate).toLocaleString("zh-CN", { timeZone: task.timeZone ?? "UTC" })}（{task.timeZone ?? "UTC"}）</span> : null}
                    {task.dueDate && task.status !== "done" && Date.parse(task.dueDate) <= now ? <Badge variant="outline" className="text-red-600">已逾期</Badge> : null}
                    {task.reminderEnabled ? <span>到期提醒</span> : null}
                    {task.repeatRule && task.repeatRule !== "none" ? <span>{repeatLabels[task.repeatRule]} · 完成后续建</span> : null}
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <Select
                      disabled={updatingTaskIds.includes(task.id)}
                      onValueChange={(value) => void updateTaskStatus(task.id, value as TaskItem["status"])}
                      value={task.status}
                    >
                      <SelectTrigger aria-label={`任务状态 ${task.title}`} className="h-8 flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="todo">待处理</SelectItem>
                        <SelectItem value="in_progress">进行中</SelectItem>
                        <SelectItem value="done">已完成</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      aria-label={`删除任务 ${task.title}`}
                      disabled={updatingTaskIds.includes(task.id)}
                      onClick={() => void deleteTask(task.id)}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 className="h-4 w-4" />
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
              {isTaskListExpanded ? "收起任务" : `展开更多（${filteredTasks.length - COLLAPSED_TASK_LIMIT}）`}
            </Button>
          ) : null}
        </section>
      </CardContent>
    </Card>
  </aside>);
}
