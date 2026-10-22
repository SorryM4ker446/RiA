import { useCallback, useEffect, useRef, useState } from "react";
import { chatApi } from "@/features/chat/api-client";
import { t } from "@/lib/locale";
import type {
  TaskItem,
  TaskScheduleInput,
  TaskStatusFilter,
} from "@/features/chat/types";
import { COLLAPSED_TASK_LIMIT } from "@/features/chat/types";
import { animateRemoval } from "@/lib/ui/removal";

export function useTasks() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [taskStatusFilter, setTaskStatusFilter] =
    useState<TaskStatusFilter>("all");
  const [loadedStatusFilter, setLoadedStatusFilter] =
    useState<TaskStatusFilter>("all");
  const [isLoadingTasks, setIsLoadingTasks] = useState(true);
  const [taskPanelError, setTaskPanelError] = useState<string | null>(null);
  const [isTaskListExpanded, setIsTaskListExpanded] = useState(false);
  const [updatingTaskIds, setUpdatingTaskIds] = useState<string[]>([]);
  const pending = useRef(new Set<string>());
  const loadVersion = useRef(0);
  const displayedFilter = isLoadingTasks
    ? loadedStatusFilter
    : taskStatusFilter;
  const filteredTasks = tasks.filter(
    (task) => displayedFilter === "all" || task.status === displayedFilter,
  );
  const visibleTasks = isTaskListExpanded
    ? filteredTasks
    : filteredTasks.slice(0, COLLAPSED_TASK_LIMIT);
  const hasHiddenTasks = filteredTasks.length > COLLAPSED_TASK_LIMIT;
  const loadTasks = useCallback(
    async (
      nextStatus: TaskStatusFilter = taskStatusFilter,
      options?: { silent?: boolean },
    ) => {
      const version = ++loadVersion.current;
      if (!options?.silent) setIsLoadingTasks(true);
      setTaskPanelError(null);
      try {
        const payload = await chatApi.listTasks(nextStatus);
        if (version === loadVersion.current) {
          setTasks(Array.isArray(payload.data) ? payload.data : []);
          setLoadedStatusFilter(nextStatus);
        }
      } catch (error) {
        if (version === loadVersion.current)
          setTaskPanelError(
            error instanceof Error
              ? error.message
              : t("chatApi.listTasksFailed"),
          );
      } finally {
        if (version === loadVersion.current) setIsLoadingTasks(false);
      }
    },
    [taskStatusFilter],
  );

  async function mutateTask(
    taskId: string,
    input: Parameters<typeof chatApi.updateTask>[1] | null,
  ) {
    if (pending.current.has(taskId)) return false;
    pending.current.add(taskId);
    setUpdatingTaskIds([...pending.current]);
    setTaskPanelError(null);
    try {
      if (input === null) {
        await chatApi.deleteTask(taskId);
        await animateRemoval(taskId, () => setTasks((current) => current.filter((task) => task.id !== taskId)));
      } else {
        const payload = await chatApi.updateTask(taskId, input);
        setTasks((current) => {
          const updated = current.map((task) =>
            task.id === taskId ? payload.data : task,
          );
          return payload.nextTask &&
            !updated.some((task) => task.id === payload.nextTask!.id)
            ? [payload.nextTask, ...updated]
            : updated;
        });
      }
      // A list response started before the mutation must not undo its result.
      loadVersion.current++;
      setIsLoadingTasks(false);
      return true;
    } catch (error) {
      setTaskPanelError(
        error instanceof Error ? error.message : t("chatApi.updateTaskFailed"),
      );
      return false;
    } finally {
      pending.current.delete(taskId);
      setUpdatingTaskIds([...pending.current]);
    }
  }

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);
  return {
    taskStatusFilter,
    isLoadingTasks,
    taskPanelError,
    isTaskListExpanded,
    filteredTasks,
    visibleTasks,
    hasHiddenTasks,
    setTaskStatusFilter: (status: TaskStatusFilter) => {
      if (status === taskStatusFilter) return;
      setIsLoadingTasks(true);
      setTaskStatusFilter(status);
    },
    setIsTaskListExpanded,
    loadTasks,
    updatingTaskIds,
    isTaskFilterPending:
      isLoadingTasks && taskStatusFilter !== loadedStatusFilter,
    updateTaskStatus: (id: string, status: TaskItem["status"]) =>
      mutateTask(id, { status }),
    saveTaskSchedule: (id: string, schedule: TaskScheduleInput) =>
      mutateTask(id, schedule),
    deleteTask: (id: string) => mutateTask(id, null),
  };
}
