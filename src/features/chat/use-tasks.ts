import { useEffect, useState } from "react";
import { chatApi } from "@/features/chat/api-client";
import type { TaskItem, TaskStatusFilter } from "@/features/chat/types";
import { COLLAPSED_TASK_LIMIT } from "@/features/chat/types";

export function useTasks() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [taskStatusFilter, setTaskStatusFilter] = useState<TaskStatusFilter>("all");
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [taskPanelError, setTaskPanelError] = useState<string | null>(null);
  const [isTaskListExpanded, setIsTaskListExpanded] = useState(false);
  const filteredTasks = tasks.filter((task) =>
    taskStatusFilter === "all" ? true : task.status === taskStatusFilter,
  );
  const visibleTasks = isTaskListExpanded ? filteredTasks : filteredTasks.slice(0, COLLAPSED_TASK_LIMIT);
  const hasHiddenTasks = filteredTasks.length > COLLAPSED_TASK_LIMIT;
  async function loadTasks(nextStatus: TaskStatusFilter = taskStatusFilter, options?: { silent?: boolean }) {
    if (!options?.silent) {
      setIsLoadingTasks(true);
    }
    setTaskPanelError(null);
    try {
      const payload = await chatApi.listTasks(nextStatus);
      setTasks(Array.isArray(payload.data) ? payload.data : []);
    } catch (error) {
      setTaskPanelError(error instanceof Error ? error.message : "读取任务失败");
    } finally {
      if (!options?.silent) {
        setIsLoadingTasks(false);
      }
    }
  }

  async function updateTaskStatus(taskId: string, statusValue: TaskItem["status"]) {
    setTaskPanelError(null);
    const previousTasks = tasks;
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? { ...task, status: statusValue, updatedAt: new Date().toISOString() } : task,
      ),
    );
    try {
      const payload = await chatApi.updateTask(taskId, statusValue);
      if (payload.data) {
        setTasks((current) => current.map((task) => (task.id === taskId ? payload.data : task)));
      }
    } catch (error) {
      setTasks(previousTasks);
      setTaskPanelError(error instanceof Error ? error.message : "更新任务失败");
    }
  }

  async function deleteTask(taskId: string) {
    setTaskPanelError(null);
    const previousTasks = tasks;
    setTasks((current) => current.filter((task) => task.id !== taskId));
    try {
      await chatApi.deleteTask(taskId);
    } catch (error) {
      setTasks(previousTasks);
      setTaskPanelError(error instanceof Error ? error.message : "删除任务失败");
    }
  }
  useEffect(() => {
    void loadTasks(taskStatusFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskStatusFilter]);
  return {
    tasks, taskStatusFilter, isLoadingTasks, taskPanelError, isTaskListExpanded, filteredTasks,
    visibleTasks, hasHiddenTasks, setTaskStatusFilter, setIsTaskListExpanded, loadTasks,
    updateTaskStatus, deleteTask,
  };
}
